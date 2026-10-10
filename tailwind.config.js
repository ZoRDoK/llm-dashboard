/**
 * Tailwind build config. Mirrors the theme tokens that pages consume via CSS
 * variables (`--theme-*`) defined in `design/themes/*.css`.
 *
 * Regenerate the stylesheet after changing classes: `npm run tailwind`.
 */
/** @type {import('tailwindcss').Config} */
export default {
  // All markup lives in TS template literals; the scanner extracts class
  // candidates from raw source text, including client-script strings.
  content: ['./src/**/*.ts'],
  theme: {
    extend: {
      colors: {
        theme: {
          bg: 'var(--theme-bg)',
          'bg-secondary': 'var(--theme-bg-secondary)',
          'bg-tertiary': 'var(--theme-bg-tertiary)',
          text: 'var(--theme-text)',
          'text-secondary': 'var(--theme-text-secondary)',
          'text-tertiary': 'var(--theme-text-tertiary)',
          accent: 'var(--theme-accent)',
          'accent-hover': 'var(--theme-accent-hover)',
          'accent-text': 'var(--theme-accent-text)',
          border: 'var(--theme-border)',
          'border-light': 'var(--theme-border-light)',
          success: 'var(--theme-success)',
          warning: 'var(--theme-warning)',
          danger: 'var(--theme-danger)',
          spend: 'var(--theme-spend)',
        },
      },
      borderRadius: {
        'theme-sm': 'var(--theme-radius-sm)',
        'theme-md': 'var(--theme-radius-md)',
        'theme-lg': 'var(--theme-radius-lg)',
      },
      boxShadow: {
        'theme-sm': 'var(--theme-shadow-sm)',
        'theme-md': 'var(--theme-shadow-md)',
        'theme-lg': 'var(--theme-shadow-lg)',
        'theme-glow': 'var(--theme-shadow-glow)',
      },
      transitionDuration: {
        theme: 'var(--theme-transition-speed)',
      },
      transitionTimingFunction: {
        theme: 'var(--theme-transition-easing)',
      },
    },
  },
};
