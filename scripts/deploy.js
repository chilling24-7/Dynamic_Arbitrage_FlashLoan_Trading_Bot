require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const { parseUnits } = require("ethers");

async function main() {
  console.log("Deploying Arbitrage contract...");

  // Ensure router addresses are in the .env file
  const sRouter = process.env.SUSHI_ROUTER;
  const uRouter = process.env.UNI_ROUTER;

  if (!sRouter || !uRouter) {
    throw new Error("Router addresses missing in .env");
  }

  const Arbitrage = await ethers.getContractFactory("Arbitrage");

  // Get the network the script is running on
  const network = hre.network.name;
  console.log(`Deploying to network: ${network}`);

  let gasOverrides = {};

  // Only set high gas for local testing to avoid EIP-1559 base fee issues
  if (network === "localhost" || network === "hardhat") {
    gasOverrides = {
      maxFeePerGas: parseUnits("100", "gwei"),
      maxPriorityFeePerGas: parseUnits("2", "gwei"),
    };
  }

  // If we are deploying on localhost, we should use a higher gas price to avoid issues
  // Example: use a mock vault on localhost
  let vaultAddress;

  switch (network) {
    case "localhost":
    case "hardhat":
      vaultAddress = "0x0000000000000000000000000000000000000001"; // mock vault for testing
      break;

    case "mainnet":
      vaultAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer mainnet
      break;

    case "avalanche":
      vaultAddress = "0xDef1C0ded9bec7F1a1670819833240f027b25EfF"; // Example: check official Balancer/Avalanche docs
      break;

    case "polygon":
      vaultAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Polygon mainnet Balancer vault
      break;

    default:
      throw new Error(`Unsupported network: ${network}`);
  }

  // Deploy contract: constructor args first, then gas overrides
  const arbitrageContract = await Arbitrage.deploy(sRouter, uRouter, vaultAddress, gasOverrides);

  console.log("Arbitrage contract deployed at:", arbitrageContract.target);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
