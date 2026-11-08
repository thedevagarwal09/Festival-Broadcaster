import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        diya: {
          50: '#fff8eb',
          100: '#ffeac6',
          200: '#ffd388',
          300: '#ffb64a',
          400: '#ff9a20',
          500: '#f97707',
          600: '#dd5302',
          700: '#b73706',
          800: '#94290c',
          900: '#7a230d',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
