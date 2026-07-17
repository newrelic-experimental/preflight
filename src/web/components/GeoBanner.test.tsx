import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { GeoBanner, type BannerTheme } from './GeoBanner';

const THEME_GRADIENT_IDS: Record<BannerTheme, string> = {
  observatory: 'obsSky',
  sessions: 'seaSky',
  history: 'histSky',
  audit: 'auditSky',
  git: 'gitSky',
};

describe('GeoBanner', () => {
  for (const [theme, id] of Object.entries(THEME_GRADIENT_IDS) as Array<[BannerTheme, string]>) {
    it(`renders the ${theme}-unique banner (gradient #${id}) and no other theme's gradient`, () => {
      const { container } = render(<GeoBanner theme={theme} />);
      expect(container.querySelector(`#${id}`)).not.toBeNull();
      for (const [otherTheme, otherId] of Object.entries(THEME_GRADIENT_IDS)) {
        if (otherTheme === theme) continue;
        expect(container.querySelector(`#${otherId}`)).toBeNull();
      }
    });
  }

  it('defaults to the observatory theme when no theme prop is given', () => {
    const { container } = render(<GeoBanner />);
    expect(container.querySelector('#obsSky')).not.toBeNull();
  });
});
