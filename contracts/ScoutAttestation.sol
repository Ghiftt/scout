// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract ScoutAttestation is Ownable {

    // ═══════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════

    struct Attestation {
        bytes32 taskId;
        address scout;
        address agent;
        uint16 confidenceBps;
        bytes32 checkpointHash;
        bytes32 captureHash;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════

    mapping(bytes32 => Attestation) public attestations;
    mapping(address => bytes32[]) public scoutAttestations;

    address public scoutRegistry;

    // ═══════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════

    event AttestationRecorded(
        bytes32 indexed taskId,
        address indexed scout,
        address indexed agent,
        uint16 confidenceBps,
        uint256 timestamp
    );

    event ScoutRegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );

    // ═══════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════

    constructor(address _scoutRegistry) Ownable(msg.sender) {
        scoutRegistry = _scoutRegistry;
    }

    // ═══════════════════════════════════════════
    // CORE FUNCTIONS
    // ═══════════════════════════════════════════

    function recordAttestation(
        bytes32 taskId,
        address scout,
        address agent,
        uint16 confidenceBps,
        bytes32 checkpointHash,
        bytes32 captureHash
    ) external {
        require(msg.sender == scoutRegistry, "Only ScoutRegistry");
        require(attestations[taskId].timestamp == 0, "Already attested");
        require(confidenceBps <= 10000, "Invalid confidence score");

        attestations[taskId] = Attestation({
            taskId: taskId,
            scout: scout,
            agent: agent,
            confidenceBps: confidenceBps,
            checkpointHash: checkpointHash,
            captureHash: captureHash,
            timestamp: block.timestamp
        });

        scoutAttestations[scout].push(taskId);

        emit AttestationRecorded(
            taskId,
            scout,
            agent,
            confidenceBps,
            block.timestamp
        );
    }

    // ═══════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════

    function getAttestation(bytes32 taskId)
        external
        view
        returns (Attestation memory)
    {
        return attestations[taskId];
    }

    function getScoutAttestations(address scout)
        external
        view
        returns (bytes32[] memory)
    {
        return scoutAttestations[scout];
    }

    function isVerified(bytes32 taskId)
        external
        view
        returns (bool)
    {
        return attestations[taskId].timestamp != 0;
    }

    // ═══════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════

    function setScoutRegistry(address _scoutRegistry)
        external
        onlyOwner
    {
        emit ScoutRegistryUpdated(scoutRegistry, _scoutRegistry);
        scoutRegistry = _scoutRegistry;
    }
}