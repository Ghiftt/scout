import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://rpc-testnet.gokite.ai/");

const TOKEN_ADDRESS = "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63";

const abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external"
];

const token = new ethers.Contract(TOKEN_ADDRESS, abi, provider);

async function check() {
  console.log("Checking token at", TOKEN_ADDRESS);

  const name = await token.name();
  const symbol = await token.symbol();
  const decimals = await token.decimals();

  console.log("Name:", name);
  console.log("Symbol:", symbol);
  console.log("Decimals:", decimals);

  // Check if transferWithAuthorization exists by looking at bytecode
  const code = await provider.getCode(TOKEN_ADDRESS);
  // ERC-3009 function selector: keccak256("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")
  const selector = "e3ee160e";
  const supported = code.includes(selector);

  console.log("ERC-3009 transferWithAuthorization supported:", supported);
}

check().catch(console.error);