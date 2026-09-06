# PulseBench

PulseBench is a small, privacy-first Windows desktop benchmark for CPU, GPU,
memory, and storage. It runs entirely on your PC, shows each component metric
separately, and can export a result as JSON.

## What it tests

| Component | Workload | Default duration | Reported metrics |
| --- | --- | ---: | --- |
| CPU | Versioned integer xorshift/multiply loop; one worker, then all logical processors | 10 s + 15 s, after warm-up | Single-thread and all-thread Mops/s, scaling |
| GPU | Fixed WebGL2 shader at 1920×1080 with synchronized draw batches | 2 s warm-up + 8 s measured | Draws/s and rendered Gpixel/s |
| Memory | Repeated copy between two pre-touched 128 MiB buffers | 4 s, after warm-up | Effective copied GiB/s |
| Storage | Buffered sequential write/read using an app-owned temporary file | 256 MiB | Write and read MiB/s |

The storage result measures application-level buffered I/O, not raw uncached
drive performance. Scores are comparable only when the PulseBench workload and
runtime versions match; they are not Cinebench, PassMark, or AIDA64 scores.

## Features

- One-click **Run all** workflow and individual component tests
- Live progress without freezing the interface
- Interactive GPU visualization
- CPU single-thread/all-thread scaling
- Local five-run history
- JSON result export
- No account, telemetry, ads, or uploads
- Temporary storage test with cleanup on completion, cancellation, and normal exit

## Download and run

PulseBench targets 64-bit Windows 10 and Windows 11. Download the portable EXE
from the repository's Releases page, or build it
locally using the steps below.

> Benchmarks briefly place the CPU and GPU under heavy load. Fans may become
> louder. Stop the test if temperatures are unsafe or the system becomes
> unstable.

## Development

Requirements:

- Node.js 24 or later
- npm 11 or later
- Windows for packaging the portable executable

```powershell
npm install
npm test
npm start
```

Build a portable Windows executable:

```powershell
npm run dist:win
```

The packaged file is written to `release/`.

The executable is unsigned, so Windows may display a SmartScreen prompt.
The storage test uses the Windows temporary-folder drive; writes include a flush,
while reads can be served from Windows' cache. Forced termination or power loss
can leave its temporary file behind. GPU scoring requires hardware WebGL2.
This performance tool does not measure CPU temperature or certify hardware health.

## Design and safety notes

- CPU, memory, and storage work runs outside Electron's main and renderer event
  loops.
- Only one benchmark can run at a time.
- The renderer uses context isolation, no Node integration, a strict Content
  Security Policy, and no remote content.
- The storage benchmark creates a uniquely named file inside an app-owned
  temporary directory and removes it in `finally` cleanup.
- JSON export only happens after the user chooses a destination.

## License

MIT
