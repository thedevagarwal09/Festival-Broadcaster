import type { Config } from 'tailwindcss';

/*
 * Colours are CSS variables (see src/app/globals.css) so light/dark mode is a single class switch
 * on <html>. "white" and "black" stay fixed; use "surface" for card/input backgrounds.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
      stone: {
        50: 'rgb(var(--stone-50) / <alpha-value>)',
        100: 'rgb(var(--stone-100) / <alpha-value>)',
        200: 'rgb(var(--stone-200) / <alpha-value>)',
        300: 'rgb(var(--stone-300) / <alpha-value>)',
        400: 'rgb(var(--stone-400) / <alpha-value>)',
        500: 'rgb(var(--stone-500) / <alpha-value>)',
        600: 'rgb(var(--stone-600) / <alpha-value>)',
        700: 'rgb(var(--stone-700) / <alpha-value>)',
        800: 'rgb(var(--stone-800) / <alpha-value>)',
        900: 'rgb(var(--stone-900) / <alpha-value>)',
        950: 'rgb(var(--stone-950) / <alpha-value>)'
      },
      diya: {
        50: 'rgb(var(--diya-50) / <alpha-value>)',
        100: 'rgb(var(--diya-100) / <alpha-value>)',
        200: 'rgb(var(--diya-200) / <alpha-value>)',
        300: 'rgb(var(--diya-300) / <alpha-value>)',
        400: 'rgb(var(--diya-400) / <alpha-value>)',
        500: 'rgb(var(--diya-500) / <alpha-value>)',
        600: 'rgb(var(--diya-600) / <alpha-value>)',
        700: 'rgb(var(--diya-700) / <alpha-value>)',
        800: 'rgb(var(--diya-800) / <alpha-value>)',
        900: 'rgb(var(--diya-900) / <alpha-value>)',
        950: 'rgb(var(--diya-950) / <alpha-value>)'
      },
      rose: {
        50: 'rgb(var(--rose-50) / <alpha-value>)',
        100: 'rgb(var(--rose-100) / <alpha-value>)',
        200: 'rgb(var(--rose-200) / <alpha-value>)',
        300: 'rgb(var(--rose-300) / <alpha-value>)',
        400: 'rgb(var(--rose-400) / <alpha-value>)',
        500: 'rgb(var(--rose-500) / <alpha-value>)',
        600: 'rgb(var(--rose-600) / <alpha-value>)',
        700: 'rgb(var(--rose-700) / <alpha-value>)',
        800: 'rgb(var(--rose-800) / <alpha-value>)',
        900: 'rgb(var(--rose-900) / <alpha-value>)',
        950: 'rgb(var(--rose-950) / <alpha-value>)'
      },
      emerald: {
        50: 'rgb(var(--emerald-50) / <alpha-value>)',
        100: 'rgb(var(--emerald-100) / <alpha-value>)',
        200: 'rgb(var(--emerald-200) / <alpha-value>)',
        300: 'rgb(var(--emerald-300) / <alpha-value>)',
        400: 'rgb(var(--emerald-400) / <alpha-value>)',
        500: 'rgb(var(--emerald-500) / <alpha-value>)',
        600: 'rgb(var(--emerald-600) / <alpha-value>)',
        700: 'rgb(var(--emerald-700) / <alpha-value>)',
        800: 'rgb(var(--emerald-800) / <alpha-value>)',
        900: 'rgb(var(--emerald-900) / <alpha-value>)',
        950: 'rgb(var(--emerald-950) / <alpha-value>)'
      },
      amber: {
        50: 'rgb(var(--amber-50) / <alpha-value>)',
        100: 'rgb(var(--amber-100) / <alpha-value>)',
        200: 'rgb(var(--amber-200) / <alpha-value>)',
        300: 'rgb(var(--amber-300) / <alpha-value>)',
        400: 'rgb(var(--amber-400) / <alpha-value>)',
        500: 'rgb(var(--amber-500) / <alpha-value>)',
        600: 'rgb(var(--amber-600) / <alpha-value>)',
        700: 'rgb(var(--amber-700) / <alpha-value>)',
        800: 'rgb(var(--amber-800) / <alpha-value>)',
        900: 'rgb(var(--amber-900) / <alpha-value>)',
        950: 'rgb(var(--amber-950) / <alpha-value>)'
      },
      sky: {
        50: 'rgb(var(--sky-50) / <alpha-value>)',
        100: 'rgb(var(--sky-100) / <alpha-value>)',
        200: 'rgb(var(--sky-200) / <alpha-value>)',
        300: 'rgb(var(--sky-300) / <alpha-value>)',
        400: 'rgb(var(--sky-400) / <alpha-value>)',
        500: 'rgb(var(--sky-500) / <alpha-value>)',
        600: 'rgb(var(--sky-600) / <alpha-value>)',
        700: 'rgb(var(--sky-700) / <alpha-value>)',
        800: 'rgb(var(--sky-800) / <alpha-value>)',
        900: 'rgb(var(--sky-900) / <alpha-value>)',
        950: 'rgb(var(--sky-950) / <alpha-value>)'
      },
      violet: {
        50: 'rgb(var(--violet-50) / <alpha-value>)',
        100: 'rgb(var(--violet-100) / <alpha-value>)',
        200: 'rgb(var(--violet-200) / <alpha-value>)',
        300: 'rgb(var(--violet-300) / <alpha-value>)',
        400: 'rgb(var(--violet-400) / <alpha-value>)',
        500: 'rgb(var(--violet-500) / <alpha-value>)',
        600: 'rgb(var(--violet-600) / <alpha-value>)',
        700: 'rgb(var(--violet-700) / <alpha-value>)',
        800: 'rgb(var(--violet-800) / <alpha-value>)',
        900: 'rgb(var(--violet-900) / <alpha-value>)',
        950: 'rgb(var(--violet-950) / <alpha-value>)'
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
