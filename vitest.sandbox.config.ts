// Real PayPal sandbox integration tests: `npm run test:sandbox`. Not part of `npm test`.
// Tests skip themselves when .secrets/dev.keys has no sandbox keys / buyer.
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['server/**/*.sandbox.ts'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
