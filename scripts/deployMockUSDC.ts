import pkg from "hardhat";
const { ethers } = pkg as any;

async function main() {
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const token = await MockUSDC.deploy();
  await token.waitForDeployment();
  const address = await token.getAddress();
  console.log("MockUSDC deployed to:", address);
  
  const [signer] = await ethers.getSigners();
  await token.mint(signer.address, ethers.parseUnits("1000", 6));
  console.log("Minted 1000 USDC to:", signer.address);
}

main().catch(console.error);