<script setup lang="ts">
/**
 * LabWeaver mark (hexagon + woven strands), drawn in currentColor so it
 * reads on any surface. `stacked` adds the wordmark + tagline underneath —
 * same geometry as LabWeaver_Logo/04_stacked_dark_transparent.svg.
 */
import { useId } from 'vue'

defineProps<{ variant?: 'mark' | 'stacked' }>()

// Each inline instance needs its own mask id.
const maskId = `lw-mask-${useId()}`
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="variant === 'stacked' ? '80 20 740 600' : '40 20 320 360'"
    role="img"
    aria-label="LabWeaver"
    class="brand-logo"
  >
    <g :transform="variant === 'stacked' ? 'translate(250,30)' : undefined">
      <mask :id="maskId">
        <rect width="400" height="400" fill="white" />
        <path d="M96,262 C150,262 150,138 200,138 C250,138 250,262 304,262" stroke="black" stroke-width="40" fill="none" stroke-linecap="round" />
      </mask>
      <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="14">
        <path d="M219.05,359.00 Q200.00,370.00 180.95,359.00 L71.83,296.00 Q52.78,285.00 52.78,263.00 L52.78,137.00 Q52.78,115.00 71.83,104.00 L180.95,41.00 Q200.00,30.00 219.05,41.00 L328.17,104.00 Q347.22,115.00 347.22,137.00 L347.22,263.00 Q347.22,285.00 328.17,296.00 Z" />
        <path :mask="`url(#${maskId})`" d="M96,138 C150,138 150,262 200,262 C250,262 250,138 304,138" />
        <path d="M96,262 C150,262 150,138 200,138 C250,138 250,262 304,262" />
        <circle cx="200" cy="200" r="16.1" fill="currentColor" stroke="none" />
      </g>
    </g>
    <template v-if="variant === 'stacked'">
      <text x="179.5" y="548" font-family="Poppins" font-weight="700" font-size="86" letter-spacing="6" fill="currentColor">LAB</text>
      <text x="358.6" y="548" font-family="Poppins" font-weight="300" font-size="86" letter-spacing="6" fill="currentColor">WEAVER</text>
      <text x="450" y="600" text-anchor="middle" font-family="Poppins" font-weight="500" font-size="18" letter-spacing="5" fill="currentColor" fill-opacity="0.7">OPEN-SOURCE AI  ·  WET + DRY LAB  ·  XR ENABLED</text>
    </template>
  </svg>
</template>
