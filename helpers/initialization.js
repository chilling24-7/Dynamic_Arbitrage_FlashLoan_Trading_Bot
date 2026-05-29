const hre = require("hardhat");
require("dotenv").config();
const config = require('../config.json');

const IUniswapV2Router02 = require('@uniswap/v2-periphery/build/IUniswapV2Router02.json');
const IUniswapV2Factory = require("@uniswap/v2-core/build/IUniswapV2Factory.json");
const IERC20 = require('@openzeppelin/contracts/build/contracts/ERC20.json');

// Set provider
const { ethers } = require("ethers");
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

// Get default signer (first account) to replace UNLOCKED_ACCOUNT
async function getSigner() {
    const [signer] = await hre.ethers.getSigners();
    return signer;
}

// Initialize Uniswap/Sushiswap contracts
const uFactory = new hre.ethers.Contract(config.UNISWAP.FACTORY_ADDRESS, IUniswapV2Factory.abi, provider);
const uRouter = new hre.ethers.Contract(config.UNISWAP.V2_ROUTER_02_ADDRESS, IUniswapV2Router02.abi, provider);
const sFactory = new hre.ethers.Contract(config.SUSHISWAP.FACTORY_ADDRESS, IUniswapV2Factory.abi, provider);
const sRouter = new hre.ethers.Contract(config.SUSHISWAP.V2_ROUTER_02_ADDRESS, IUniswapV2Router02.abi, provider);

// Initialize Arbitrage contract
const IArbitrage = require('../artifacts/contracts/Arbitrage.sol/Arbitrage.json');
const arbitrage = new hre.ethers.Contract(config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS, IArbitrage.abi, provider);

// USDC contract (optional, for balance tracking)
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const usdc = new hre.ethers.Contract(USDC_ADDRESS, IERC20.abi, provider);

module.exports = {
    provider,
    uFactory,
    uRouter,
    sFactory,
    sRouter,
    arbitrage,
    usdc,
    getSigner
};
