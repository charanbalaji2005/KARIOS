import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink:     '#10131A',   // page
        panel:   '#171B24',   // surfaces
        raised:  '#1E232E',   // hover, inputs
        edge:    '#2A303C',   // hairlines
        body:    '#DCE1EA',   // primary text
        muted:   '#7F8898',   // secondary text
        signal:  '#7C6BF2',   // primary action (violet)
        mint:    '#4FC48B',   // success / connected
        amber:   '#E2A23B',   // warnings, pending
        coral:   '#E4685D',   // destructive
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: { sm: '3px', DEFAULT: '5px', lg: '8px' },
    },
  },
  plugins: [],
} satisfies Config;
