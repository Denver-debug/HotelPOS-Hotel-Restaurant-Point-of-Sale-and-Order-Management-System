export default {
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/__tests__/**/*.test.js"],
  setupFiles: ["<rootDir>/__tests__/setup-env.js"],
  testTimeout: 30000,
  verbose: true,
};
