// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// ═══════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════

interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IScoutAttestation {
    function recordAttestation(
        bytes32 taskId,
        address scout,
        address agent,
        uint16 confidenceBps,
        bytes32 checkpointHash,
        bytes32 captureHash
    ) external;
}

contract ScoutRegistry is ReentrancyGuard, Ownable {

    // ═══════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════

    struct Authorization {
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
    bytes32 authHash;
}

    enum TaskType {
    Verify,
    Execute
}

    struct Task {
        bytes32 taskId;
        address agent;
        address scout;
        address paymentToken;
        uint256 paymentAmount;
        uint16 minConfidence;
        uint256 createdAt;
        uint256 expiresAt;
        TaskStatus status;
        bytes32 checkpointHash;
        string captureURI;
        TaskType taskType;
        string[] proofRequired;
        Authorization auth;
    }

    enum TaskStatus {
        Open,
        Accepted,
        Submitted,
        Verified,
        Failed,
        Expired,
        Cancelled,
        Rejected
    }

    // ═══════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════

    mapping(bytes32 => Task) public tasks;
    mapping(address => bytes32[]) public agentTasks;
    mapping(address => bytes32[]) public scoutTasks;
    mapping(bytes32 => bytes32) public taskCheckpointHashes;
    mapping(address => bytes32) public agentPolicyHash;
    mapping(address => string) public agentPolicyURI;

    address public verificationService;
    address public attestationContract;

    uint256 public constant MIN_TASK_DURATION = 5 minutes;
    uint256 public constant MAX_TASK_DURATION = 24 hours;

    // ═══════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════

    event PolicySet(
        address indexed agent,
        bytes32 policyHash,
        string policyURI
    );

    event TaskCreated(
        bytes32 indexed taskId,
        address indexed agent,
        address paymentToken,
        uint256 paymentAmount,
        uint16 minConfidence,
        TaskType taskType,
        uint256 expiresAt
    );

    event TaskAccepted(
        bytes32 indexed taskId,
        address indexed scout,
        uint256 acceptedAt
    );

    event TaskSubmitted(
        bytes32 indexed taskId,
        address indexed scout,
        string captureURI,
        uint256 submittedAt
    );

    event TaskFailed(
        bytes32 indexed taskId,
        string reason
    );

    event TaskExpired(
        bytes32 indexed taskId
    );

    event TaskCancelled(
        bytes32 indexed taskId,
        address indexed agent
    );

    event ScoutTaskCompleted(
    bytes32 indexed taskId,
    address indexed scout,
    bytes32 indexed checkpointHash,
    uint16 confidenceScore,
    uint256 paymentAmount
);

    // ═══════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════

    constructor(
        address _verificationService,
        address _attestationContract
    ) Ownable(msg.sender) {
        verificationService = _verificationService;
        attestationContract = _attestationContract;
    }

    // ═══════════════════════════════════════════
    // AGENT FUNCTIONS
    // ═══════════════════════════════════════════

    function createTask(
    bytes32 taskId,
    address paymentToken,
    uint256 paymentAmount,
    uint16 minConfidence,
    uint256 durationSeconds,
    bytes32 checkpointHash,
    TaskType taskType,
    string[] memory proofRequired,
    Authorization memory auth
) external nonReentrant {
    require(tasks[taskId].createdAt == 0, "Task already exists");
    require(paymentAmount > 0, "Payment must be greater than zero");
    require(minConfidence > 0 && minConfidence <= 100, "Invalid confidence threshold");
    require(
        durationSeconds >= MIN_TASK_DURATION &&
        durationSeconds <= MAX_TASK_DURATION,
        "Invalid task duration"
    );
    require(
        auth.validBefore > block.timestamp + durationSeconds,
        "Authorization expires too soon"
    );

    uint256 expiresAt = block.timestamp + durationSeconds;

    tasks[taskId] = Task({
        taskId: taskId,
        agent: msg.sender,
        scout: address(0),
        paymentToken: paymentToken,
        paymentAmount: paymentAmount,
        minConfidence: minConfidence,
        createdAt: block.timestamp,
        expiresAt: expiresAt,
        status: TaskStatus.Open,
        checkpointHash: checkpointHash,
        captureURI: "",
        taskType: taskType,
        proofRequired: proofRequired,
        auth: auth
    });

    taskCheckpointHashes[taskId] = checkpointHash;
    agentTasks[msg.sender].push(taskId);

    emit TaskCreated(
        taskId,
        msg.sender,
        paymentToken,
        paymentAmount,
        minConfidence,
        taskType,
        expiresAt
    );
}

    function cancelTask(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.createdAt != 0, "Task does not exist");
        require(task.agent == msg.sender, "Only agent can cancel");
        require(task.status == TaskStatus.Open, "Can only cancel open tasks");

        task.status = TaskStatus.Cancelled;

        emit TaskCancelled(taskId, msg.sender);
    }

    function setPolicy(
    bytes32 policyHash,
    string memory policyURI
) external {
    require(policyHash != bytes32(0), "Invalid policy hash");
    require(bytes(policyURI).length > 0, "Policy URI required");

    agentPolicyHash[msg.sender] = policyHash;
    agentPolicyURI[msg.sender] = policyURI;

    emit PolicySet(msg.sender, policyHash, policyURI);
}

function getPolicy(address agent)
    external
    view
    returns (bytes32 policyHash, string memory policyURI)
{
    return (agentPolicyHash[agent], agentPolicyURI[agent]);
}

    // ═══════════════════════════════════════════
    // SCOUT FUNCTIONS
    // ═══════════════════════════════════════════

    function acceptTask(bytes32 taskId) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.createdAt != 0, "Task does not exist");
        require(task.status == TaskStatus.Open, "Task not open");
        require(block.timestamp < task.expiresAt, "Task expired");
        require(task.agent != msg.sender, "Agent cannot be Scout");

        task.scout = msg.sender;
        task.status = TaskStatus.Accepted;

        scoutTasks[msg.sender].push(taskId);

        emit TaskAccepted(taskId, msg.sender, block.timestamp);
    }

    function submitProof(
        bytes32 taskId,
        string memory captureURI
    ) external nonReentrant {
        Task storage task = tasks[taskId];

        require(task.createdAt != 0, "Task does not exist");
        require(task.status == TaskStatus.Accepted, "Task not accepted");
        require(task.scout == msg.sender, "Not assigned Scout");
        require(block.timestamp < task.expiresAt, "Task expired");
        require(bytes(captureURI).length > 0, "Capture URI required");

        task.captureURI = captureURI;
        task.status = TaskStatus.Submitted;

        emit TaskSubmitted(
            taskId,
            msg.sender,
            captureURI,
            block.timestamp
        );
    }

    // ═══════════════════════════════════════════
    // VERIFICATION SERVICE FUNCTIONS
    // ═══════════════════════════════════════════

    function verifyAndPay(
    bytes32 taskId,
    uint16 confidenceScore,
    uint8 v,
    bytes32 r,
    bytes32 s
) external nonReentrant {
    require(
        msg.sender == verificationService,
        "Only verification service"
    );

    Task storage task = tasks[taskId];

    require(task.createdAt != 0, "Task does not exist");
    require(task.status == TaskStatus.Submitted, "Task not submitted");
    require(
        confidenceScore >= task.minConfidence,
        "Confidence below threshold"
    );

    task.status = TaskStatus.Verified;

    IERC3009(task.paymentToken).transferWithAuthorization(
        task.agent,
        task.scout,
        task.paymentAmount,
        task.auth.validAfter,
        task.auth.validBefore,
        task.auth.nonce,
        v,
        r,
        s
    );

    IScoutAttestation(attestationContract).recordAttestation(
    taskId,
    task.scout,
    task.agent,
    uint16(confidenceScore),
    task.checkpointHash,
    keccak256(bytes(task.captureURI))
);

    emit ScoutTaskCompleted(
        taskId,
        task.scout,
        task.checkpointHash,
        confidenceScore,
        task.paymentAmount
    );
}

    function rejectTask(
        bytes32 taskId,
        string memory reason
    ) external {
        require(
            msg.sender == verificationService,
            "Only verification service"
        );

        Task storage task = tasks[taskId];

        require(task.createdAt != 0, "Task does not exist");
        require(task.status == TaskStatus.Submitted, "Task not submitted");

        // Return to Accepted so Scout can resubmit
        task.status = TaskStatus.Accepted;
        task.captureURI = "";

        emit TaskFailed(taskId, reason);
    }

    function failTaskPermanently(
        bytes32 taskId,
        string memory reason
    ) external {
        require(
            msg.sender == verificationService,
            "Only verification service"
        );

        Task storage task = tasks[taskId];

        require(task.createdAt != 0, "Task does not exist");
        require(task.status == TaskStatus.Submitted, "Task not submitted");

        task.status = TaskStatus.Failed;

        emit TaskFailed(taskId, reason);
    }

    // ═══════════════════════════════════════════
    // EXPIRY
    // ═══════════════════════════════════════════

    function expireTask(bytes32 taskId) external {
        Task storage task = tasks[taskId];

        require(task.createdAt != 0, "Task does not exist");
        require(
            task.status == TaskStatus.Open ||
            task.status == TaskStatus.Accepted,
            "Task cannot be expired"
        );
        require(block.timestamp >= task.expiresAt, "Task not expired yet");

        task.scout = address(0);
        task.status = TaskStatus.Expired;

        emit TaskExpired(taskId);
    }

    // ═══════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════

    function getTask(bytes32 taskId)
        external
        view
        returns (Task memory)
    {
        return tasks[taskId];
    }

    function getAgentTasks(address agent)
        external
        view
        returns (bytes32[] memory)
    {
        return agentTasks[agent];
    }

    function getScoutTasks(address scout)
        external
        view
        returns (bytes32[] memory)
    {
        return scoutTasks[scout];
    }

    // ═══════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════

    function setVerificationService(address _verificationService)
        external
        onlyOwner
    {
        verificationService = _verificationService;
    }

    function setAttestationContract(address _attestationContract)
        external
        onlyOwner
    {
        attestationContract = _attestationContract;
    }
}