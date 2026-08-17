/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  moduleNameMapper: {
    // Route `import ... from 'vscode'` to the lightweight mock.
    '^vscode$': '<rootDir>/test/__mocks__/vscode.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // The vscode mock lives under test/__mocks__ but is not itself a test.
  testPathIgnorePatterns: ['/node_modules/', '/test/__mocks__/', '/test/helpers.ts'],
};
