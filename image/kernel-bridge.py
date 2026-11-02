#!/usr/bin/env python3
"""Jupyter kernel bridge for the claude-bioflow adapter.

Runs as a child of the Node adapter. Takes commands on stdin (one JSON object
per line) and emits events on stdout (one JSON object per line).

Commands (stdin):
  {"op":"execute","cell_id":"<id>","code":"<src>","kernelspec":"python3|ir"}
  {"op":"interrupt"}
  {"op":"restart"}
  {"op":"shutdown"}
  {"op":"status"}

Events (stdout):
  {"op":"iopub","cell_id":"<id|null>","msg_type":"stream|execute_result|display_data|error|status","content":{...}}
  {"op":"execute_reply","cell_id":"<id>","status":"ok|error","execution_count":<n>}
  {"op":"restarted"}
  {"op":"interrupted"}
  {"op":"status","state":"starting|idle|busy|dead"}
  {"op":"error","error":"<msg>"}
"""
from __future__ import annotations

import json
import queue
import sys
import threading
import traceback
from typing import Any, Dict, Optional

from jupyter_client.manager import KernelManager


# How long a cell's execute_reply waits for its iopub idle (see Bridge._finish).
IDLE_GRACE_S = 10.0


def emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


class Bridge:
    def __init__(self) -> None:
        self.km: Optional[KernelManager] = None
        self.kc = None
        self.kernelspec = "python3"
        # Map: parent msg_id -> cell_id (for tagging iopub messages).
        self.pending: Dict[str, str] = {}
        # Map: parent msg_id -> what has arrived of its end (the execute_reply
        # and/or the iopub idle). See _finish.
        self._ends: Dict[str, Dict[str, Any]] = {}
        self._ends_lock = threading.Lock()
        self._iopub_thread: Optional[threading.Thread] = None

    def ensure(self, kernelspec: str) -> None:
        if self.km and self.km.is_alive() and kernelspec == self.kernelspec:
            return
        if self.km:
            try:
                self.km.shutdown_kernel(now=True)
            except Exception:
                pass
        self.kernelspec = kernelspec or "python3"
        self.pending.clear()  # stale msg_ids from old kernel will never reply
        self._ends.clear()
        emit({"op": "status", "state": "starting"})
        self.km = KernelManager(kernel_name=self.kernelspec)
        self.km.start_kernel()
        self.kc = self.km.client()
        self.kc.start_channels()
        # wait_for_ready can legitimately take >60s when the old kernel is
        # holding ~5GB of CUDA memory and its teardown blocks on driver
        # cleanup. Bump the window and ALWAYS start the reader threads,
        # even if wait_for_ready raised — the kernel usually IS ready by
        # the time we hit the timeout, we just couldn't confirm via the
        # ready handshake.
        try:
            self.kc.wait_for_ready(timeout=120)
        except Exception as e:
            emit({"op": "error", "error": f"wait_for_ready: {e}"})
        emit({"op": "status", "state": "idle"})
        self._start_iopub_reader()

    def _start_iopub_reader(self) -> None:
        # Stop any previous reader implicitly by rebinding — threads are daemon.
        thread = threading.Thread(target=self._iopub_loop, daemon=True)
        thread.start()
        self._iopub_thread = thread
        # Single dedicated shell-channel reader (dispatches execute_reply
        # msgs to cell_ids via self.pending). Bind to the current kc so
        # the loop naturally exits on restart when kc is rebound.
        shell_thread = threading.Thread(target=self._shell_loop, daemon=True)
        shell_thread.start()

    def _shell_loop(self) -> None:
        kc = self.kc
        while kc is self.kc and kc is not None:
            try:
                reply = kc.get_shell_msg(timeout=0.5)
            except queue.Empty:
                continue
            except Exception as e:
                emit({"op": "error", "error": f"shell read failed: {e}"})
                return
            content = reply.get("content") or {}
            reply_parent = (reply.get("parent_header") or {}).get("msg_id")
            event = {
                "op": "execute_reply",
                "status": content.get("status", "ok"),
                "execution_count": content.get("execution_count"),
                "error": content.get("ename"),
            }
            if reply_parent in self.pending:
                self._finish(reply_parent, reply=event)
                # iopub drops messages past its high-water mark; if the idle
                # was one of them, don't hold the reply (and the cell) forever.
                timer = threading.Timer(IDLE_GRACE_S, self._finish, (reply_parent,), {"idle": True})
                timer.daemon = True
                timer.start()
            else:
                emit({**event, "cell_id": ""})

    def _iopub_loop(self) -> None:
        kc = self.kc
        while kc is self.kc and kc is not None:
            try:
                msg = kc.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                continue
            except Exception as e:
                emit({"op": "error", "error": f"iopub read failed: {e}"})
                return
            parent = (msg.get("parent_header") or {}).get("msg_id")
            cell_id = self.pending.get(parent)
            msg_type = msg.get("msg_type")
            content = msg.get("content") or {}
            emit({
                "op": "iopub",
                "cell_id": cell_id,
                "msg_type": msg_type,
                "content": content,
                "parent_msg_id": parent,
            })
            if msg_type == "status":
                state = content.get("execution_state")
                if state == "idle" and parent in self.pending:
                    self._finish(parent, idle=True)

    def _finish(self, msg_id: str, **end: Any) -> None:
        """Emit a cell's execute_reply once its iopub idle has also arrived.
        The reply (shell channel) can beat the last outputs (iopub channel),
        e.g. a large IRkernel plot. Emitting it early made the adapter stop
        collecting, and untagged the late outputs so the panel dropped them."""
        with self._ends_lock:
            if msg_id not in self.pending:
                return
            ends = self._ends.setdefault(msg_id, {})
            ends.update(end)
            if "reply" not in ends or not ends.get("idle"):
                return
            cell_id = self.pending.pop(msg_id)
            del self._ends[msg_id]
        emit({**ends["reply"], "cell_id": cell_id})

    def execute(self, cell_id: str, code: str, kernelspec: str) -> None:
        self.ensure(kernelspec or "python3")
        assert self.kc is not None
        msg_id = self.kc.execute(code, store_history=True)
        self.pending[msg_id] = cell_id
        # Shell reader runs as a single dedicated thread (see
        # _start_shell_reader); we don't spawn one thread per execute,
        # which previously accumulated blocked-forever threads racing
        # for get_shell_msg on the shared shell channel.

    def interrupt(self) -> None:
        if self.km:
            self.km.interrupt_kernel()
        emit({"op": "interrupted"})

    def restart(self) -> None:
        if not self.km:
            emit({"op": "restarted"})
            return
        # Tear down cleanly rather than km.restart_kernel(), which shares
        # port state and historically hangs when the old kernel is slow to
        # release CUDA memory. Force a fresh shutdown → fresh start via
        # ensure(), which has proper pending/cleanup handling.
        self.pending.clear()
        self._ends.clear()
        try:
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        self.km = None
        self.kc = None
        self.ensure(self.kernelspec)
        emit({"op": "restarted"})

    def shutdown(self) -> None:
        if self.km:
            try:
                self.km.shutdown_kernel(now=True)
            except Exception:
                pass
        emit({"op": "status", "state": "dead"})

    def status(self) -> None:
        alive = bool(self.km and self.km.is_alive())
        emit({"op": "status", "state": "idle" if alive else "dead"})


def main() -> None:
    bridge = Bridge()
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"op": "error", "error": f"bad json: {e}"})
            continue
        op = cmd.get("op")
        try:
            if op == "execute":
                bridge.execute(
                    cmd.get("cell_id", ""),
                    cmd.get("code", ""),
                    cmd.get("kernelspec", "python3"),
                )
            elif op == "interrupt":
                bridge.interrupt()
            elif op == "restart":
                bridge.restart()
            elif op == "shutdown":
                bridge.shutdown()
                return
            elif op == "status":
                bridge.status()
            else:
                emit({"op": "error", "error": f"unknown op: {op}"})
        except Exception as e:
            emit({"op": "error", "error": str(e),
                  "trace": traceback.format_exc()})


if __name__ == "__main__":
    main()
