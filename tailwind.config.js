import daisyui from 'daisyui';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans"', 'sans-serif'],
        display: ['"Noto Sans Display"', 'sans-serif'],
        lexend: ['"Lexend Exa"', 'sans-serif']
      }
    }
  },
  plugins: [daisyui],
  daisyui: {
    themes: ['light', 'dark'],
    logs: false
  }
};
