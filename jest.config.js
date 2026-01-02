module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  collectCoverageFrom: ['helpers/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
  verbose: true
};
