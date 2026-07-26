// Public surface of the command bus.
export * from './types';
export * from './selection';
export * from './element';
export * from './structural';
export * from './piece';
export { COMMANDS, COMMAND_LIST, commandsByCategory } from './registry';
export { executeCommand, installCommandApi, commandSchema, type ExecuteHost } from './execute';
