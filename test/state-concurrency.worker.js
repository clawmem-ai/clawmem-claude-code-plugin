const { mutateState } = require("../lib/state");

const ITERATIONS = Number(process.env.CLAWMEM_WORKER_ITERATIONS) || 20;

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

for (let i = 0; i < ITERATIONS; i += 1) {
  mutateState((s) => {
    s.concurrencyCounter = (s.concurrencyCounter || 0) + 1;
  });
  sleepSync(Math.floor(Math.random() * 6));
}

process.exit(0);
