export const theme = {
  colors: {
    primary: '#1E8E82',
    primaryLight: '#2FB8A9',
    background: '#0B1220',
    backgroundCard: '#141C2E',
    backgroundElevated: '#1B2438',
    backgroundInput: '#101828',
    border: '#243049',
    textPrimary: '#F1F5F9',
    textSecondary: '#94A3B8',
    textMuted: '#64748B',
    success: '#10B981',
    successLight: '#34D399',
    warning: '#F59E0B',
    danger: '#EF4444',
  },
  radius: {
    sm: 10,
    md: 16,
  },
  spacing: (n: number) => n * 4,
};

export type Theme = typeof theme;
