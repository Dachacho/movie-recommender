import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { THEME_STORAGE_KEY } from './theme';

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('ThemeToggle', () => {
  it('starts light and toggles to dark', () => {
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: 'Switch to dark mode' });

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeDefined();
  });

  it('uses a persisted dark theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeDefined();
  });
});
