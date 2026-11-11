import { describe, expect, it } from 'vitest';
import { approveInSandbox, assertSandboxApproveUrl, isAllowedNavigation } from './approver';

describe('assertSandboxApproveUrl', () => {
  it('accepts PayPal sandbox approval links', () => {
    expect(() => assertSandboxApproveUrl('https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T')).not.toThrow();
  });
  it.each([
    'https://www.paypal.com/checkoutnow?token=X',
    'http://www.sandbox.paypal.com/checkoutnow?token=X',
    'https://sandbox.paypal.com/checkoutnow?token=X',
    'https://www.sandbox.paypal.com.evil.example/checkoutnow?token=X',
    'https://evil.example/?u=https://www.sandbox.paypal.com',
    'javascript:alert(1)',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertSandboxApproveUrl(url)).toThrow(/sandbox/i);
  });
});

describe('isAllowedNavigation', () => {
  it('only allows the sandbox host for top-level navigations', () => {
    expect(isAllowedNavigation('https://www.sandbox.paypal.com/signin')).toBe(true);
    expect(isAllowedNavigation('https://www.paypal.com/signin')).toBe(false);
    expect(isAllowedNavigation('http://localhost:5173/store/northpeak?checkout=return')).toBe(false);
  });
});

describe('approveInSandbox guards', () => {
  it('refuses a non-sandbox URL before launching a browser', async () => {
    await expect(approveInSandbox('https://www.paypal.com/checkoutnow?token=X', { email: 'b@example.com', password: 'x' })).rejects.toThrow(/sandbox/i);
  });
  it('refuses to run without sandbox buyer credentials', async () => {
    await expect(approveInSandbox('https://www.sandbox.paypal.com/checkoutnow?token=X', { email: '', password: '' })).rejects.toThrow(/SANDBOX_BUYER/);
  });
});
