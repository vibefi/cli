import { parseAbi, parseAbiItem } from "viem";

export const governorAbi = parseAbi([
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function proposalDeadline(uint256 proposalId) view returns (uint256)",
  "function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)",
  "function castVote(uint256 proposalId, uint8 support) returns (uint256)",
  "function castVoteWithReason(uint256 proposalId, uint8 support, string reason) returns (uint256)",
  "function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
  "function vetoProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)"
]);

export const dappRegistryAbi = parseAbi([
  "function publishDapp(bytes rootCid, string name, string version, string description) returns (uint256 dappId, uint256 versionId)",
  "function pauseDappVersion(uint256 dappId, uint256 versionId, string reason)",
  "function unpauseDappVersion(uint256 dappId, uint256 versionId, string reason)",
  "function deprecateDappVersion(uint256 dappId, uint256 versionId, string reason)"
]);

export const proposalCreatedEvent = parseAbiItem(
  "event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)"
);

export const dappPublishedEvent = parseAbiItem(
  "event DappPublished(uint256 indexed dappId, uint256 indexed versionId, bytes rootCid, address proposer)"
);

export const dappUpgradedEvent = parseAbiItem(
  "event DappUpgraded(uint256 indexed dappId, uint256 indexed fromVersionId, uint256 indexed toVersionId, bytes rootCid, address proposer)"
);

export const dappMetadataEvent = parseAbiItem(
  "event DappMetadata(uint256 indexed dappId, uint256 indexed versionId, string name, string version, string description)"
);

export const dappPausedEvent = parseAbiItem(
  "event DappPaused(uint256 indexed dappId, uint256 indexed versionId, address pausedBy, string reason)"
);

export const dappUnpausedEvent = parseAbiItem(
  "event DappUnpaused(uint256 indexed dappId, uint256 indexed versionId, address unpausedBy, string reason)"
);

export const dappDeprecatedEvent = parseAbiItem(
  "event DappDeprecated(uint256 indexed dappId, uint256 indexed versionId, address deprecatedBy, string reason)"
);
