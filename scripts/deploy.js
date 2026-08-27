require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const chalk = require("chalk");
const config = require("../config.json");

// ---------------- ORANGE BORDER ----------------
const ORANGE = "\x1b[38;5;208m";
const WHITE = "\x1b[37m";
const RESET = "\x1b[0m";

const WIDTH = 72;

// ───────── ANSI + width fix ─────────
function stripAnsi(str = "") {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(str = "") {
  return [...stripAnsi(str)].length;
}

function pad(str, width) {
  const len = visibleLength(str);
  return str + " ".repeat(Math.max(0, width - len));
}

// ───────── unified border pieces ─────────
function top() {
  console.log(ORANGE + "┌" + "─".repeat(WIDTH) + "┐" + RESET);
}

function mid() {
  console.log(ORANGE + "├" + "─".repeat(WIDTH) + "┤" + RESET);
}

function bottom() {
  console.log(ORANGE + "└" + "─".repeat(WIDTH) + "┘" + RESET);
}

// ───────── HELPER ─────────
// Strip ANSI codes
function stripAnsi(str = "") {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// Approximate terminal width: count wide characters (emoji, CJK)
function visibleLength(str = "") {
  const s = stripAnsi(str);
  let len = 0;
  for (const char of s) {
    // Unicode codepoint > 0x1F000 is usually double width (rough heuristic)
    len += char.match(/[^\x00-\xff]/) ? 2 : 1;
  }
  return len;
}

function pad(str, width) {
  const len = visibleLength(str);
  return str + " ".repeat(Math.max(0, width - len));
}

// ───────── ROW ─────────
function row(text, isTitle = false) {
  let fullText = isTitle ? "🚀 " + text : text;
  console.log(
    ORANGE + "│" + RESET +
    WHITE + pad(fullText, WIDTH) + RESET +
    ORANGE + "│" + RESET
  );
}

// ───────── SECTION BOX ─────────
function box(title, lines = []) {
  top();
  row(title, true);
  mid();

  for (const l of lines) {
    row(l);
  }

  bottom();
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = BigInt(network.chainId);

  const isHardhat = chainId === 31337n;
  const isLocal = isHardhat && config.PROJECT_SETTINGS.isLocal === true;
  const isFork = isHardhat && config.PROJECT_SETTINGS.isLocal === false;
  const isLive = !isHardhat;

  let mode =
    isLocal
      ? "LOCALHOST (clean test)"
      : isFork
        ? "ARBITRUM FORK (Hardhat)"
        : "LIVE ARBITRUM";

  // ---------------- HEADER ----------------
  box("DEPLOYING ARBITRAGE CONTRACT", [
    `Mode: ${mode}`,
    `Chain ID: ${chainId}n`,
    `Fork Active: ${isFork}`,
    `Local Mode: ${isLocal}`,
  ]);

  // ---------------- FORK CHECK (ONLY IF FORK) ----------------
  if (isFork) {
    try {
      const code = await ethers.provider.getCode(
        config.PROJECT_SETTINGS.WETH_ADDRESS
      );

      if (code !== "0x") {
        console.log("✔ Fork confirmed (WETH exists)");
      } else {
        console.log("✖ Fork not detected properly");
      }
    } catch (e) {
      console.log("✖ Fork check failed:", e.message);
    }
  }

  // ---------------- ADDRESS SELECTION ----------------
 let uniRouter, pancakeRouter, vault;

  if (isLocal) {
      // local mocks or test addresses
      uniRouter = config.UNISWAP_V3.ROUTER_ADDRESS;
      pancakeRouter = config.PANCAKESWAP_V3.ROUTER_ADDRESS;
      vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  } else if (isFork || isLive) {
      // real Arbitrum addresses
      uniRouter = config.UNISWAP_V3.ROUTER_ADDRESS;
      pancakeRouter = config.PANCAKESWAP_V3.ROUTER_ADDRESS;
      vault = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  }

  box("📡 CONTRACT ADDRESSES", [
    `Uniswap V3 Router: ${uniRouter}`,
    `PancakeSwap V3 Router: ${pancakeRouter}`,
    `Balancer Vault: ${vault}`,
  ]);

  // ---------------- DEPLOY ----------------
  const Arbitrage = await ethers.getContractFactory("Arbitrage");

  const contract = await Arbitrage.deploy(
    uniRouter,
    pancakeRouter,
    vault
  );

  // ✅ FIX FOR ETHER V6 (THIS WAS YOUR ERROR)
  await contract.waitForDeployment();

  const address = await contract.getAddress();

  box("✅ DEPLOYMENT SUCCESSFUL", [
    `Contract Address: ${address}`,
    `Mode: ${mode}`,
  ]);

  console.log(chalk.green("\n✔ Deployment complete!\n"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

///// Works!!!!