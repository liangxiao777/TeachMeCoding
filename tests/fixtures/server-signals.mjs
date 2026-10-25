// Windows cannot deliver POSIX SIGTERM to another process. Exercise the same
// application shutdown handler through test-only IPC, without a production API.
process.on('message', (message) => {
  if (message !== 'shutdown') return;
  process.disconnect();
  process.emit('SIGTERM');
});
process.channel?.unref();
