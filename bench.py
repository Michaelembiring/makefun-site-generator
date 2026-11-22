#!/usr/bin/env python3
# Benchmark: CPU time of an entry's main.ts on the practice set, net of a do-nothing
# control, trimmed mean over rounds — mirroring the grader's heat.
import subprocess, sys, os, time, statistics, tempfile, shutil

NODE = sys.argv[1] if len(sys.argv) > 1 else 'node'
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 9
HERE = os.path.dirname(os.path.abspath(__file__))
IN_DIR = '/tmp/bench_in'
PRACTICE = '/tmp/sg_kit/site-generator-speed-01-run-20261122-kit/practice/input/cases.json'

def cpu_time(entry_main):
    """Run `node main.ts` in a fresh process on the practice set; return CPU (user+sys) seconds."""
    out = tempfile.mkdtemp()
    env = dict(os.environ, MAKEFUN_INPUT_DIR=IN_DIR, MAKEFUN_OUTPUT_DIR=out)
    t0 = time.time()
    p = subprocess.run([NODE, entry_main], env=env, capture_output=True, text=True)
    wall = time.time() - t0
    if p.returncode != 0:
        print("RUN FAILED:", p.stderr[:500]); shutil.rmtree(out, ignore_errors=True); sys.exit(1)
    # use resource usage of children via /usr/bin/time -p instead for accuracy
    shutil.rmtree(out, ignore_errors=True)
    return wall

def cpu_time_accurate(entry_main):
    """Measure user+sys CPU of the child via /usr/bin/time -p."""
    out = tempfile.mkdtemp()
    env = dict(os.environ, MAKEFUN_INPUT_DIR=IN_DIR, MAKEFUN_OUTPUT_DIR=out)
    p = subprocess.run(['/usr/bin/time', '-p', NODE, entry_main], env=env, capture_output=True, text=True)
    shutil.rmtree(out, ignore_errors=True)
    if p.returncode != 0:
        print("RUN FAILED:", p.stderr[:800]); sys.exit(1)
    user = sys_t = 0.0
    for line in p.stderr.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == 'user': user = float(parts[1])
        if len(parts) == 2 and parts[0] == 'sys': sys_t = float(parts[1])
    return user + sys_t

def bench(entry_main, rounds):
    # warmup
    cpu_time_accurate(entry_main)
    times = [cpu_time_accurate(entry_main) for _ in range(rounds)]
    times.sort()
    # trimmed mean: drop 2 fastest and 2 slowest (like grader) when enough rounds
    if len(times) >= 6:
        trimmed = times[2:-2]
    else:
        trimmed = times
    return statistics.mean(trimmed), times

# do-nothing control
control_dir = tempfile.mkdtemp()
with open(os.path.join(control_dir, 'main.mjs'), 'w') as f:
    f.write("import {readFileSync,writeFileSync} from 'node:fs';"
            "const c=JSON.parse(readFileSync(process.env.MAKEFUN_INPUT_DIR+'/cases.json','utf8'));"
            "writeFileSync(process.env.MAKEFUN_OUTPUT_DIR+'/answers.json','[]');")
control_main = os.path.join(control_dir, 'main.mjs')

os.makedirs(IN_DIR, exist_ok=True)
if not os.path.exists(os.path.join(IN_DIR, 'cases.json')):
    shutil.copy(PRACTICE, os.path.join(IN_DIR, 'cases.json'))

entries = {
    'control': control_main,
    'baseline': os.path.join(HERE, 'baseline', 'main.ts'),
    'candidate': os.path.join(HERE, 'entry', 'main.ts'),
}
results = {}
for name, path in entries.items():
    mean, times = bench(path, ROUNDS)
    results[name] = mean
    print(f"{name:10s} CPU {mean*1000:7.1f} ms  (rounds: {[round(t*1000,1) for t in times]})")

ctrl = results['control']
base_net = results['baseline'] - ctrl
cand_net = results['candidate'] - ctrl
print(f"\nnet of control: baseline {base_net*1000:.1f} ms, candidate {cand_net*1000:.1f} ms")
print(f"speedup: {base_net/cand_net:.2f}x  (candidate is {100*(1-cand_net/base_net):.0f}% less CPU)")