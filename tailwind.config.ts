import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Acuity bands, sampled from the pathway PDF's own stroke colors.
        acuity: {
          low: '#89c979',
          intermediate: '#d0cf6f',
          high: '#e8b1a9',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
