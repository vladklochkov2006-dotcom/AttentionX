/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        yc: {
          purple: '#06B6D4',
          green: '#10B981',
          red: '#EF4444',
          dark: '#060D12',
          'dark-panel': '#0C1A24',
          'dark-border': '#1A3040',
          light: '#FFFFFF',
          'light-panel': '#F3F4F6',
          'light-border': '#E5E7EB',
          'text-primary': '#111827',
          'text-secondary': '#6B7280',
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      animation: {
        'float': 'float 4s ease-in-out infinite',
        'spin-slow': 'spin 10s linear infinite',
        'spin-reverse-slow': 'spin-reverse 12s linear infinite',
        'pulse-fast': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'marquee': 'marquee 30s linear infinite',
        'slideUp': 'slideUp 0.3s ease-out',
        'fadeIn': 'fadeIn 0.3s ease-out',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px) rotateY(0deg)' },
          '50%': { transform: 'translateY(-10px) rotateY(5deg)' },
        },
        'spin-reverse': {
          from: { transform: 'rotate(360deg)' },
          to: { transform: 'rotate(0deg)' },
        },
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        slideUp: {
          from: { transform: 'translateY(100%)', opacity: 0 },
          to: { transform: 'translateY(0)', opacity: 1 },
        },
        fadeIn: {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        fadeInUp: {
          from: { opacity: 0, transform: 'translateY(10px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
