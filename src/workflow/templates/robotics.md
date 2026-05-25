<!--
  AGENT.md — Meta-Agent Workflow Definition
  Mode: robotics
  Version: 1.0
-->

# Robotics Algorithm Development Workflow

This workflow guides the development of robot algorithms through five structured phases:
from algorithm research and selection, through implementation and training, to sim-to-real
validation and production deployment on physical hardware.

Each phase has explicit gate criteria that must be met before advancing. REQUIRED gates
block advancement; APPROVAL gates require user confirmation; SUGGESTED gates are best
practices that can be skipped with justification.

The workflow supports both legged locomotion, robotic arm manipulation, autonomous
navigation (SLAM), and aerial robotics (UAV/drone). Adapt the focus areas to your
specific robot platform and algorithm domain.

---

## Phase: research | 算法研究 | Algorithm Research

### Focus
Survey the literature, identify candidate algorithms, understand the problem constraints,
and select an approach. The output is a clear algorithm specification and a validated
simulation environment ready for development.

### Primary Agents
- **LiteratureAgent**: ArXiv/Semantic Scholar search, paper summarization, citation graph
- **BenchmarkAgent**: Find existing benchmarks and baselines for the target task
- **EnvironmentAgent**: Locate or configure simulation environments (MuJoCo, Isaac Gym, Gazebo, PyBullet)

### Key Activities

**1. Problem Definition**
- Define the robot platform (DoF, actuator limits, sensor suite)
- Specify the task objective (e.g., stable gait at 2 m/s on rough terrain)
- Document constraints (compute budget, latency requirements, safety bounds)

**2. Literature Survey**
- Search ArXiv for recent work (last 3 years preferred)
- Identify 3–5 candidate algorithms with pros/cons analysis
- Extract key hyperparameters and training tricks from top papers

**3. Algorithm Selection**
- Score candidates on: sample efficiency, sim-to-real transferability, compute cost
- Select primary algorithm and one fallback
- Document the rationale in `docs/algorithm_selection.md`

**4. Environment Setup**
- Install and verify simulation environment
- Implement or import robot URDF/MJCF model
- Verify physics parameters match real hardware (mass, inertia, friction)
- Run a random policy for 1000 steps to confirm environment stability

### Gate Criteria
- [ ] REQUIRED: Problem definition documented (robot platform, task objective, constraints)
- [ ] REQUIRED: Literature survey complete (≥5 papers reviewed, 2–3 candidates identified)
- [ ] REQUIRED: Primary algorithm selected with written rationale
- [ ] REQUIRED: Simulation environment running and stable (1000-step random policy passes)
- [ ] APPROVAL: Algorithm selection reviewed and approved by user
- [ ] SUGGESTED: Baseline benchmark established (random policy / classical controller score)
- [ ] SUGGESTED: Existing pretrained weights located and tested as starting point

### Outputs
- `docs/algorithm_selection.md` — algorithm comparison and selection rationale
- `docs/problem_definition.md` — task spec, robot spec, constraints
- `envs/` — simulation environment configuration and wrapper
- `baseline_results.json` — baseline performance metrics

---

## Phase: development | 算法开发 | Algorithm Development

### Focus
Implement the selected algorithm, build the training infrastructure, and achieve a working
proof-of-concept in simulation. Code quality and reproducibility are priorities here —
a clean implementation makes sim-to-real transfer far easier.

### Primary Agents
- **CodingAgent**: Algorithm implementation, network architecture, loss functions
- **TestingAgent**: Unit tests for environment wrappers, reward functions, obs/action spaces
- **ProvenanceAgent**: Experiment tracking, git commits, config versioning

### Key Activities

**1. Core Algorithm Implementation**
- Implement policy network (MLP / Transformer / GNN as appropriate)
- Implement value function / critic if using actor-critic methods
- Implement the training loop with proper logging
- Add gradient clipping and numerical stability checks

**2. Reward Function Design**
- Implement task reward (forward velocity, target reaching, etc.)
- Add regularization terms (energy cost, smoothness penalty, contact forces)
- Add safety penalties (joint limit violations, fall detection)
- Tune reward weights to produce reasonable initial behavior

**3. Observation & Action Space**
- Define observation vector (proprioception, exteroception, privileged info)
- Define action space (joint positions, velocities, or torques)
- Implement observation normalization and action scaling
- Verify obs/act shapes match network I/O

**4. Training Infrastructure**
- Set up experiment tracking (Weights & Biases / TensorBoard / custom logging)
- Implement checkpoint saving and resumption
- Add early stopping and learning rate scheduling
- Create reproducible run configuration (YAML/JSON config files)

**5. Initial Training Runs**
- Run 5M step training with default hyperparameters
- Verify loss curves are decreasing and not diverging
- Achieve task success rate > 30% in simulation (sanity check threshold)

### Gate Criteria
- [ ] REQUIRED: Core algorithm implemented and unit-tested (obs/act spaces, reward function)
- [ ] REQUIRED: Training infrastructure complete (logging, checkpointing, config files)
- [ ] REQUIRED: Initial training run completes without crash (5M steps or task-appropriate horizon)
- [ ] REQUIRED: Policy achieves >30% task success rate in simulation (proof of concept)
- [ ] REQUIRED: Code committed to git with reproducible config
- [ ] APPROVAL: Implementation approach reviewed and approved by user before extended training
- [ ] SUGGESTED: Ablation study on reward weights completed
- [ ] SUGGESTED: Unit tests cover >70% of core algorithm code

### Outputs
- `src/` — algorithm implementation (policy, critic, training loop)
- `configs/` — training configuration files (YAML/JSON)
- `tests/` — unit tests for core components
- `runs/dev_initial/` — initial training run artifacts

---

## Phase: training | 训练探索 | Training Exploration

### Focus
Systematic hyperparameter tuning, extended training runs, and algorithm refinement to
maximize simulation performance. Use the ExperienceStore to track experiment history and
avoid repeating failed configurations.

### Primary Agents
- **TrainingAgent**: Run training jobs, monitor convergence, manage compute
- **HyperparamAgent**: Bayesian optimization / grid search over key hyperparameters
- **AnalysisAgent**: Analyze training curves, identify failure modes, suggest fixes

### Key Activities

**1. Hyperparameter Sweep**
Priority parameters to sweep (in order of impact):
- Learning rate: [1e-4, 3e-4, 1e-3]
- Batch size: [1024, 4096, 16384]
- Network size: [256×2, 512×2, 256×3]
- Reward scale and key reward weights
- Algorithm-specific (e.g., PPO clip ratio, SAC temperature)

**2. Curriculum Learning (if applicable)**
- Start with simplified task (flat terrain, slow speed, reduced DoF)
- Gradually increase difficulty as success rate improves
- Document curriculum schedule in `configs/curriculum.yaml`

**3. Domain Randomization**
- Randomize physics parameters: mass ±10%, friction ±20%, motor gains ±15%
- Randomize initial conditions: joint positions, velocities
- Add observation noise (sensor noise model)
- Verify policy is robust across the randomization distribution

**4. Extended Training**
- Run best configuration for full training budget (50M+ steps typical for locomotion)
- Monitor for policy collapse, reward hacking, and mode collapse
- Save checkpoints every 5M steps for analysis

**5. Evaluation Protocol**
- Define evaluation episodes (deterministic, fixed seeds)
- Measure: mean reward, success rate, episode length, energy cost
- Compare against baseline and literature benchmarks

### Gate Criteria
- [ ] REQUIRED: Hyperparameter sweep complete (≥10 configurations explored)
- [ ] REQUIRED: Best configuration identified and documented
- [ ] REQUIRED: Extended training run complete with best config
- [ ] REQUIRED: Simulation performance meets target (task-specific threshold, document in config)
- [ ] REQUIRED: Domain randomization implemented and policy validated under randomization
- [ ] APPROVAL: Training results reviewed by user before proceeding to sim-to-real
- [ ] SUGGESTED: Curriculum learning implemented and documented
- [ ] SUGGESTED: Policy behavior visualized and qualitatively assessed (video/plots)
- [ ] SUGGESTED: Failure mode analysis completed with mitigations noted

### Outputs
- `runs/sweep_results.json` — hyperparameter sweep results
- `runs/best/` — best trained policy checkpoint
- `docs/training_report.md` — training analysis, convergence plots, benchmarks
- `configs/best_config.yaml` — final training configuration

---

## Phase: sim2real | Sim2Real 验证 | Sim-to-Real Validation

### Focus
Transfer the trained policy to real hardware with systematic safety checks at each step.
This phase follows a strict escalation protocol: benchtop → low-speed → full-speed.
Never skip a safety gate. Hardware damage and personnel safety are top priorities.

### Primary Agents
- **HardwareAgent**: Interface with robot hardware, read sensors, send commands
- **SafetyAgent**: Monitor joint limits, force/torque limits, emergency stop conditions
- **CalibrationAgent**: Calibrate sim-to-real gaps (observation offsets, action delays)

### Safety Rules (Non-Negotiable)
1. **Always have a physical emergency stop** within reach before any hardware test
2. **Start with the robot suspended** (off ground) for first policy deployment
3. **Enforce joint position and velocity limits** in the low-level controller at all times
4. **Use a safety harness / tether** for legged robots during initial walking tests
5. **Log all hardware interactions** to disk before and after each test session
6. **Never deploy a policy** that has not passed simulation evaluation in Phase 3

### Key Activities

**1. Hardware Interface Setup**
- Install ROS2 workspace (or hardware SDK)
- Implement observation reader (joint encoders, IMU, force/torque sensors)
- Implement action writer (joint position/velocity/torque commands)
- Verify communication latency is within policy timing budget
- Test emergency stop functionality

**2. Observation Gap Analysis**
- Compare real vs. sim observation distributions (10-minute data collection)
- Identify systematic offsets (encoder zero offsets, IMU bias, joint backlash)
- Apply calibration corrections to observation pipeline
- Document all identified gaps in `docs/obs_gaps.md`

**3. Benchtop Deployment (Robot Suspended)**
- Deploy policy with robot secured off ground
- Verify joint commands are physically reasonable (no oscillations, no runaway)
- Check action frequency matches simulation timestep
- Verify emergency stop cuts power within 50ms

**4. Low-Speed / Restricted Tests**
- Deploy on ground with safety harness / reduced speed limit (50% of sim)
- Collect 10 minutes of real hardware rollouts
- Compare real performance metrics against simulation benchmarks
- Identify and address top-3 sim-to-real failure modes

**5. Adaptive Policies (if needed)**
- If direct transfer fails, implement adaptation layer:
  - RMA (Rapid Motor Adaptation) online estimator
  - System identification online update
  - Privileged information distillation
- Retrain with real data (sim+real hybrid if needed)

**6. Full Performance Validation**
- Run evaluation protocol from Phase 3 on real hardware
- Measure: success rate, energy cost, stability metrics
- Document comparison vs. simulation benchmarks

### Gate Criteria
- [ ] REQUIRED: Hardware interface implemented and tested (obs/act pipeline verified)
- [ ] REQUIRED: Emergency stop tested and confirmed <50ms response
- [ ] REQUIRED: Benchtop deployment passed (no unsafe commands, no runaway)
- [ ] REQUIRED: Observation gap analysis completed and calibration applied
- [ ] REQUIRED: Low-speed hardware tests completed (≥10 min real rollouts)
- [ ] REQUIRED: Top-3 sim-to-real failure modes documented and addressed
- [ ] APPROVAL: User approves full-speed hardware deployment after reviewing low-speed results
- [ ] SUGGESTED: Adaptation layer implemented if direct transfer success rate <50%
- [ ] SUGGESTED: Video recording of all hardware tests saved

### Outputs
- `ros2_ws/` or `hw_interface/` — hardware interface implementation
- `data/real_rollouts/` — recorded real hardware trajectories
- `docs/obs_gaps.md` — observation gap analysis and calibration
- `docs/sim2real_report.md` — transfer results, failure mode analysis

---

## Phase: deployment | 工程化部署 | Engineering Deployment

### Focus
Package the validated policy for production deployment: optimize inference, add monitoring,
create deployment scripts, write documentation, and establish a maintenance procedure.

### Primary Agents
- **OptimizationAgent**: TensorRT / ONNX export, quantization, latency benchmarking
- **PackagingAgent**: Docker/container packaging, dependency management, version tagging
- **DocumentationAgent**: API docs, deployment guide, troubleshooting runbook

### Key Activities

**1. Inference Optimization**
- Export policy to ONNX or TorchScript
- Profile inference latency on target compute hardware
- Apply quantization (INT8/FP16) if latency budget requires it
- Verify quantized policy maintains >95% of full-precision performance

**2. ROS2 Integration Package**
- Create ROS2 node: subscribes to sensor topics, publishes action commands
- Implement parameter server integration for runtime config
- Add health check topic and diagnostic messages
- Write launch files for single-robot and multi-robot deployments

**3. Monitoring & Observability**
- Implement real-time performance metrics publisher (success rate, energy, stability)
- Add anomaly detection (detect policy distribution shift from training)
- Set up alerting for safety limit violations
- Create Grafana/custom dashboard for ops monitoring

**4. Deployment Packaging**
- Create Dockerfile with all dependencies pinned
- Write `deploy.sh` script (one-command deployment)
- Version tag the release (git tag + release notes)
- Test deployment from clean environment (no existing dependencies)

**5. Documentation**
- Write deployment guide: prerequisites, installation, configuration, first run
- Write operator runbook: startup, shutdown, emergency procedures, common issues
- Document API: observation/action format, ROS2 topics, config parameters
- Archive experiment history and key design decisions

**6. Maintenance Plan**
- Define policy retraining triggers (performance degradation thresholds)
- Document data collection procedure for continual learning
- Schedule periodic hardware calibration checks
- Define rollback procedure (keep previous stable version deployed)

### Gate Criteria
- [ ] REQUIRED: Policy exported to production format (ONNX/TorchScript) and latency verified
- [ ] REQUIRED: ROS2 deployment package created and tested from clean environment
- [ ] REQUIRED: Monitoring and safety alerting implemented and tested
- [ ] REQUIRED: Deployment documentation complete (guide + runbook + API docs)
- [ ] REQUIRED: Version tagged in git with release notes
- [ ] APPROVAL: Final deployment reviewed and signed off by user
- [ ] SUGGESTED: Inference quantization applied and validated
- [ ] SUGGESTED: Automated deployment test (CI pipeline) created
- [ ] SUGGESTED: Continual learning / retraining pipeline documented

### Outputs
- `deploy/` — Dockerfile, deploy.sh, deployment configs
- `ros2_ws/src/<robot>_policy/` — ROS2 policy node package
- `docs/deployment_guide.md` — installation and configuration guide
- `docs/operator_runbook.md` — operations and emergency procedures
- `CHANGELOG.md` — release notes and version history
