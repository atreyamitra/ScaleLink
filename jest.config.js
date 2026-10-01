module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  verbose: true,
  // The integration tests share one real Redis database and FLUSHDB between
  // tests, so test files must never run in parallel.
  maxWorkers: 1,
  // tests/helpers/* are support code, not tests.
  testPathIgnorePatterns: ['/node_modules/', '/tests/helpers/'],
};
