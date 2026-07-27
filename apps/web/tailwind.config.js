/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#6d5efc',
          50: '#f3f1ff',
          100: '#e9e6ff',
          200: '#d4ccff',
          300: '#b6a8ff',
          400: '#9d8aff',
          500: '#6d5efc',
          600: '#5a48f0',
          700: '#4a38d4',
          800: '#3e30ab',
          900: '#352c87',
        },
      },
    },
  },
  plugins: [],
}
