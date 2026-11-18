# Robot-side latency benchmark

Measures what the robot side of web teleop adds between ROS 2 and the operator's browser, and checks that two robot-side implementations behave the same. It was written to compare the headless-Firefox robot page (rosbridge + roslibjs + canvas) with the Python robot peer that replaced it (`start_robot_peer.py`: rclpy + aiortc).

Everything runs on one machine, so wall-clock timestamps from ROS and from the browser can be compared directly.

## What it measures

| Metric                     | From → to                                                                                                                        |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| Video latency              | camera frame published on ROS → frame presented in the operator's `<video>`. The mock camera paints its publish time into each frame as a 32-cell barcode, and the operator decodes it in `requestVideoFrameCallback`. |
| Fresh frames/s             | distinct camera frames the operator actually saw per second                                                                      |
| Telemetry latency          | `/joint_states` published → `validJointState` received on the data channel (the mock publishes its wall time as a joint position) |
| Command latency            | `setJointVelocity` / `driveBase` sent on the data channel → message arrives on `/teleop/joint_vel` / `/teleop/cmd_vel`             |
| Action / service RTT       | `setRobotPose` → `FollowJointTrajectory` goal → "movement successful!" back at the operator; `seedLocalization` → `std_srvs/Trigger` → reply |
| Robot-side CPU and memory  | sampled once a second from `/proc` while streaming; memory is PSS, so shared pages in a multi-process browser count once           |
| Behaviour parity           | one of every operator command; records each reply on the data channel and each call it caused in ROS                            |

## Files

- `mock_robot.py`: stands in for the driver and cameras (parameters, topics, services, a trajectory action server that succeeds at once) and logs when commands reach ROS.
- `operator_harness.js`: a minimal operator injected into headless Chromium. It speaks the same signaling and data-channel protocol as the real operator page.
- `measure_latency.js`: drives the harness, pairs timestamps, samples CPU and memory, and prints or compares results.
- `run_benchmark.sh`: brings the whole stack up, runs one measurement, and tears it down.

## Running

Stop the real interface first (`./stop_interface.sh`); the benchmark needs ports 443 and 9090. Then, with ROS 2 sourced and `dist/` built (`npm run build:localstorage`):

```bash
npx playwright install chromium          # once, for the headless operator
tools/latency/run_benchmark.sh python    # -> tools/latency/results/python.json
```

To measure the old robot page, check out a commit from before it was removed and build it there:

```bash
git worktree add --detach /tmp/baseline <commit-before-robot-peer>
cd /tmp/baseline && ln -s "$OLDPWD/node_modules" node_modules && ln -s "$OLDPWD/.env" .env
ln -sf "$OLDPWD"/certificates/*.pem certificates/ && npm run build:localstorage && cd -
BASELINE_DIR=/tmp/baseline tools/latency/run_benchmark.sh browser   # needs rosbridge_server installed
```

Compare the two runs, including the behaviour parity table:

```bash
node tools/latency/measure_latency.js --compare tools/latency/results/browser.json tools/latency/results/python.json
```

`CAMERA_FPS` sets the mock camera rate (default 15 Hz, matching `configure_video_streams.py`). `--no-parity`, `--stream-seconds`, `--command-hz` and the other options are listed at the top of `measure_latency.js`.

## Caveats

- The mock cameras are synthetic: moving gradients plus noise, JPEG-encoded at quality 85. Real camera content compresses differently, so absolute bitrates will vary.
- The operator runs on the same machine as the robot side and competes with it for CPU. Network latency is not included.
- Video latency includes the mock's own JPEG encode (a few ms) and the operator's decode and jitter buffer. Both implementations pay these equally.
