"""Tests for memory-builder.py. Run inside the user image, which has the parsers:

    docker run --rm -v "$PWD/image:/t" -w /t --entrypoint python3 claude-bioflow:dev -B \
        -m unittest test_memory_builder -v
"""
import csv
import importlib.util
import io
import json
import os
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout

import fitz  # PyMuPDF
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("memory_builder", os.path.join(HERE, "memory-builder.py"))
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)


def write_pdf(path, text):
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    doc.save(path)


def write_docx(path, paragraphs):
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    xml = ('<?xml version="1.0" encoding="UTF-8"?><w:document '
           'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f"<w:body>{body}</w:body></w:document>")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", xml)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.dir = os.path.join(self.root, "local_projects", "ngs")
        os.makedirs(os.path.join(self.dir, ".git"))
        os.makedirs(os.path.join(self.dir, "raw"))
        write_pdf(os.path.join(self.dir, "rna_extraction_protocol.pdf"),
                  "RNA extraction SOP. Step 1: lyse cells in TRIzol.")
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "reagents"
        ws.append(["Reagent", "Vendor", "Catalog", "Lot", "Location"])
        ws.append(["TRIzol", "Thermo", "15596026", "L123", "Fridge 2"])
        ws.append(["DNase I", "NEB", "M0303S", "L456", "Freezer A"])
        wb.save(os.path.join(self.dir, "inventory.xlsx"))
        with open(os.path.join(self.dir, "sequencing_orders.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Order ID", "Samples", "Platform", "Cell line"])
            w.writerow(["20643R", "12", "NovaSeq X", "HEK293"])
            w.writerow(["20701R", "8", "NovaSeq X", "K562"])
            w.writerow(["", "", "", ""])
        write_docx(os.path.join(self.dir, "notes.docx"), ["Lab meeting notes", "Use the new lot of DNase."])
        with open(os.path.join(self.dir, "raw", "sample.bam"), "wb") as f:
            f.write(b"\x00BAM\x01" * 100)
        with open(os.path.join(self.dir, ".git", "config"), "w") as f:
            f.write("[core]")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = mb.main(list(argv))
        return code, out.getvalue()


class TestScan(Fixture):
    def test_lists_parseable_files_and_skips_binaries_and_dot_folders(self):
        code, out = self.run_cli("scan", self.root, "local_projects/ngs")
        self.assertEqual(code, 0)
        res = json.loads(out)
        by_path = {f["path"]: f for f in res["files"]}
        self.assertEqual(by_path["local_projects/ngs/sequencing_orders.csv"]["action"], "parse")
        self.assertEqual(by_path["local_projects/ngs/inventory.xlsx"]["kind"], "table")
        self.assertEqual(by_path["local_projects/ngs/rna_extraction_protocol.pdf"]["kind"], "document")
        self.assertEqual(by_path["local_projects/ngs/raw/sample.bam"]["action"], "skip")
        self.assertNotIn("local_projects/ngs/.git/config", by_path)
        self.assertEqual(res["estimate"], {"table_rows": 4, "documents": 2})

    def test_refuses_a_path_outside_the_workspace(self):
        code, out = self.run_cli("scan", self.root, "../etc")
        self.assertEqual(code, 2)
        self.assertIn("outside the workspace", json.loads(out)["error"])


class TestParse(Fixture):
    def items(self, *extra):
        code, out = self.run_cli("parse", self.root, "local_projects/ngs", *extra)
        self.assertEqual(code, 0)
        return [json.loads(line) for line in out.splitlines() if line.strip()]

    def test_rows_become_categorised_entries_with_provenance(self):
        items = self.items()
        entries = [i for i in items if i["type"] == "entry"]
        orders = [e for e in entries if e["origin"].endswith("sequencing_orders.csv")]
        self.assertEqual([e["name"] for e in orders], ["20643R", "20701R"])
        o = orders[0]
        self.assertEqual(o["category"], "data_record")
        self.assertEqual(o["facets"]["order_id"], ["20643R"])
        self.assertEqual(o["facets"]["cell_line"], ["HEK293"])
        self.assertIn("Order ID: 20643R", o["body"])
        self.assertRegex(o["origin_sha256"], r"^[0-9a-f]{64}$")
        self.assertLessEqual(len(o["description"]), 200)

        inv = [e for e in entries if e["origin"].endswith("inventory.xlsx")]
        self.assertEqual([(e["category"], e["name"]) for e in inv], [("inventory", "TRIzol"), ("inventory", "DNase I")])
        self.assertEqual(inv[0]["facets"]["reagent"], ["TRIzol"])

    def test_documents_come_back_as_text_for_the_model(self):
        docs = {i["path"]: i for i in self.items() if i["type"] == "document"}
        self.assertIn("lyse cells in TRIzol", docs["local_projects/ngs/rna_extraction_protocol.pdf"]["text"])
        self.assertIn("new lot of DNase", docs["local_projects/ngs/notes.docx"]["text"])

    def test_skips_are_reported(self):
        skipped = {i["path"]: i["reason"] for i in self.items() if i["type"] == "skipped"}
        self.assertIn("local_projects/ngs/raw/sample.bam", skipped)

    def test_per_table_mode_makes_one_entry_per_sheet(self):
        entries = [i for i in self.items("--tables", "per_table") if i["type"] == "entry"]
        self.assertEqual(len([e for e in entries if e["origin"].endswith("sequencing_orders.csv")]), 1)

    def test_a_single_file_can_be_parsed(self):
        code, out = self.run_cli("parse", self.root, "local_projects/ngs/sequencing_orders.csv")
        self.assertEqual(code, 0)
        self.assertEqual(len([l for l in out.splitlines() if '"entry"' in l]), 2)


if __name__ == "__main__":
    unittest.main()
