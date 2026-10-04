// Tests must never reach the public release service or a real swarm.
process.env.TRUFFLE_NO_UPDATE_CHECK ??= "1";
process.env.TRUFFLE_DIR = undefined;
delete process.env.TRUFFLE_DIR;
delete process.env.TRUFFLE_PROFILE;
delete process.env.TRUFFLE_CONFIG;
