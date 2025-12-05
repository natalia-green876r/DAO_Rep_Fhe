pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract DAOReputationPortabilityFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60;
    bool public paused;

    struct ReputationBatch {
        uint256 batchId;
        bool isOpen;
        uint256 reputationSum; // Sum of all submitted reputations in this batch
        uint256 submissionCount; // Number of submissions in this batch
    }
    mapping(uint256 => ReputationBatch) public batches;
    uint256 public currentBatchId = 1;

    struct ReputationSubmission {
        euint32 encryptedReputation;
        address provider;
        uint256 batchId;
    }
    ReputationSubmission[] public submissions;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 indexed cooldownSeconds);
    event Paused(address account);
    event Unpaused(address account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ReputationSubmitted(address indexed provider, uint256 indexed batchId, uint256 submissionIndex);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalReputation, uint256 averageReputation);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier checkSubmissionCooldown(address _provider) {
        if (block.timestamp < lastSubmissionTime[_provider] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown(address _provider) {
        if (block.timestamp < lastDecryptionRequestTime[_provider] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "New owner is the zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) public onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) public onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) public onlyOwner {
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(newCooldownSeconds);
    }

    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() public onlyOwner {
        require(paused, "Contract not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openBatch() public onlyOwner whenNotPaused {
        batches[currentBatchId] = ReputationBatch({
            batchId: currentBatchId,
            isOpen: true,
            reputationSum: 0,
            submissionCount: 0
        });
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() public onlyOwner whenNotPaused {
        if (!batches[currentBatchId].isOpen) revert InvalidBatch();
        batches[currentBatchId].isOpen = false;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
    }

    function submitReputation(euint32 encryptedReputation) public onlyProvider whenNotPaused checkSubmissionCooldown(msg.sender) {
        if (!batches[currentBatchId].isOpen) revert BatchNotOpen();
        if (!encryptedReputation.isInitialized()) revert NotInitialized();

        uint256 submissionIndex = submissions.length;
        submissions.push(ReputationSubmission({
            encryptedReputation: encryptedReputation,
            provider: msg.sender,
            batchId: currentBatchId
        }));
        batches[currentBatchId].submissionCount++;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ReputationSubmitted(msg.sender, currentBatchId, submissionIndex);
    }

    function requestBatchDecryption(uint256 batchId) public onlyProvider whenNotPaused checkDecryptionCooldown(msg.sender) {
        if (batchId >= currentBatchId || !batches[batchId].isOpen) revert InvalidBatch();

        ReputationBatch storage batch = batches[batchId];
        if (batch.submissionCount == 0) {
            revert("Batch has no submissions");
        }

        euint32 encryptedTotalReputation;
        euint32 encryptedAverageReputation;
        bool initialized = false;

        for (uint256 i = 0; i < submissions.length; i++) {
            if (submissions[i].batchId == batchId) {
                if (!initialized) {
                    encryptedTotalReputation = submissions[i].encryptedReputation;
                    initialized = true;
                } else {
                    encryptedTotalReputation = encryptedTotalReputation.add(submissions[i].encryptedReputation);
                }
            }
        }

        if (!initialized) {
            revert("No submissions found for batch"); // Should not happen due to submissionCount check
        }

        encryptedAverageReputation = encryptedTotalReputation.mul(FHE.asEuint32(batch.submissionCount).inv());

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = encryptedTotalReputation.toBytes32();
        cts[1] = encryptedAverageReputation.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild cts array in the exact same order as in requestBatchDecryption
        ReputationBatch storage batch = batches[decryptionContexts[requestId].batchId];
        euint32 encryptedTotalReputation;
        euint32 encryptedAverageReputation;
        bool initialized = false;

        for (uint256 i = 0; i < submissions.length; i++) {
            if (submissions[i].batchId == decryptionContexts[requestId].batchId) {
                if (!initialized) {
                    encryptedTotalReputation = submissions[i].encryptedReputation;
                    initialized = true;
                } else {
                    encryptedTotalReputation = encryptedTotalReputation.add(submissions[i].encryptedReputation);
                }
            }
        }
        encryptedAverageReputation = encryptedTotalReputation.mul(FHE.asEuint32(batch.submissionCount).inv());

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = encryptedTotalReputation.toBytes32();
        cts[1] = encryptedAverageReputation.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32 totalReputation = abi.decode(cleartexts, (uint32));
        uint32 averageReputation = abi.decode(cleartexts[32:], (uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalReputation, averageReputation);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (!x.isInitialized()) {
            x = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 x) internal pure {
        if (!x.isInitialized()) {
            revert NotInitialized();
        }
    }
}