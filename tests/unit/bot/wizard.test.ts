import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerApp: vi.fn(),
}));

vi.mock('@larksuite/channel', () => ({
  registerApp: mocks.registerApp,
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn() },
}));

import { DOCUMENT_MEDIA_DOWNLOAD_SCOPE } from '../../../src/bot/app-scope.js';
import { runRegistrationWizard } from '../../../src/bot/wizard.js';

describe('registration wizard scopes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mocks.registerApp.mockReset();
    mocks.registerApp.mockResolvedValue({
      client_id: 'cli_test',
      client_secret: 'secret-test',
      user_info: { tenant_brand: 'feishu', open_id: 'ou-owner' },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('requests cloud-document media download for the app identity', async () => {
    await runRegistrationWizard();

    expect(mocks.registerApp).toHaveBeenCalledWith(
      expect.objectContaining({
        addons: { scopes: { tenant: [DOCUMENT_MEDIA_DOWNLOAD_SCOPE] } },
      }),
    );
  });
});
