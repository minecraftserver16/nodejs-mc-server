const { startServer } = require('./src/server');

startServer().catch((error) => {
  console.error(`Failed to start PureNodeMC: ${error.message}`);
  process.exitCode = 1;
});
