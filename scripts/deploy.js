import hre from "hardhat";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // Deploy ScoutAttestation first with placeholder registry
  const ScoutAttestation = await hre.ethers.getContractFactory("ScoutAttestation");
  const attestation = await ScoutAttestation.deploy(
    hre.ethers.ZeroAddress
  );
  await attestation.waitForDeployment();
  console.log("ScoutAttestation deployed to:", await attestation.getAddress());

  // Deploy ScoutRegistry
  const ScoutRegistry = await hre.ethers.getContractFactory("ScoutRegistry");
  const registry = await ScoutRegistry.deploy(
    hre.ethers.ZeroAddress,
    await attestation.getAddress()
  );
  await registry.waitForDeployment();
  console.log("ScoutRegistry deployed to:", await registry.getAddress());

  // Update ScoutAttestation with real ScoutRegistry address
  const tx = await attestation.setScoutRegistry(await registry.getAddress());
  await tx.wait();
  console.log("ScoutAttestation updated with ScoutRegistry address");

  console.log("\n--- Deployment Complete ---");
  console.log("ScoutAttestation:", await attestation.getAddress());
  console.log("ScoutRegistry:", await registry.getAddress());
  console.log("Update VERIFICATION_SERVICE in ScoutRegistry after backend deployment");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});