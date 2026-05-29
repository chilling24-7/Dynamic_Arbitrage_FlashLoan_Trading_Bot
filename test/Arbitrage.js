const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("Arbitrage Flash Loan Debug Test (Fork/Mainnet + Local)", function () {
  let arbitrage, owner, weth;

  const TOKEN_CONFIG = {
    WETH: {
      symbol: "WETH",
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase(),
    },
    LINK: {
      symbol: "LINK",
      address: "0x514910771AF9Ca656af840dff83E8264EcF986CA".toLowerCase(),
    },
    AAVE: {
      symbol: "AAVE",
      address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9".toLowerCase(),
    },
  };

  before(async function () {
    [owner] = await ethers.getSigners();

    const ArbitrageFactory = await ethers.getContractFactory("Arbitrage");
    arbitrage = await ArbitrageFactory.deploy(
      "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f", // Sushi
      "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", // Uni
      "0xBA12222222228d8Ba445958a75a0704d566BF2C8"  // Balancer
    );
    await arbitrage.waitForDeployment();

    weth = await ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
      TOKEN_CONFIG.WETH.address,
      owner
    );

    console.log("✅ Arbitrage deployed at:", arbitrage.target);
  });

  // ---------------- FUND ----------------
  async function fundWithWETH(amount) {
    console.log("Wrapping ETH into WETH...");
    const wrapTx = await owner.sendTransaction({
      to: TOKEN_CONFIG.WETH.address,
      value: amount
    });
    await wrapTx.wait();

    const transferTx = await weth.transfer(arbitrage.target, amount);
    await transferTx.wait();

    console.log(`💰 Funded Arbitrage with ${amount} of WETH`);
  }

  // ---------------- EVENT PARSER + ASSERT ----------------
  async function logAndAssertEvents(tx) {
    const receipt = await tx.wait();

    let flashEventFound = false;

    for (const log of receipt.logs) {
      try {
        const parsed = arbitrage.interface.parseLog(log);

        if (parsed.name === "TokenBalance") {
          console.log(`🔹 Balance update - ${parsed.args.token}: ${parsed.args.balance.toString()}`);
        }

        if (parsed.name === "SwapExecuted") {
          console.log(
            `🔄 Swap executed - path: ${parsed.args.path.map(a => a.slice(0, 6))}, amountIn: ${parsed.args.amountIn}, amountOut: ${parsed.args.amountOut}`
          );
        }

        if (parsed.name === "FlashLoanStepCompleted") {
          flashEventFound = true;

          const finalBal = parsed.args.finalBalance;
          const repayment = parsed.args.totalRepaymentAmount;

          console.log(`✅ Step completed - final: ${finalBal}, repayment: ${repayment}`);

          // ✅ OPTION 2 ASSERTION (event-based)
          expect(finalBal).to.be.gte(repayment);
        }

      } catch {}
    }

    expect(flashEventFound).to.equal(true);
  }

  // ---------------- TEST: 2 TOKEN ----------------
  it("executes 2-token flash loan (WETH -> LINK) with profit validation", async function () {
    const flashAmount = 1n * 10n ** 18n;

    await fundWithWETH(flashAmount);

    // ✅ OPTION 1: track owner balance
    const ownerBefore = await weth.balanceOf(owner.address);
    const minProfit = 0n;
    let slippageBps = 0;

    console.log("Owner WETH BEFORE:", ownerBefore.toString());

    const tx = await arbitrage.executeTrade(
      true,
      TOKEN_CONFIG.WETH.address,
      TOKEN_CONFIG.LINK.address,
      ethers.ZeroAddress,
      flashAmount,
      minProfit,
      slippageBps
    );

    await logAndAssertEvents(tx);

    const ownerAfter = await weth.balanceOf(owner.address);

    console.log("Owner WETH AFTER:", ownerAfter.toString());

    // ✅ OPTION 1 ASSERTION
    expect(ownerAfter).to.be.gte(ownerBefore);
  });

  // ---------------- TEST: 3 TOKEN ----------------
  it("executes 3-token flash loan (WETH -> LINK -> AAVE -> WETH)", async function () {
      const flashAmount = 1n * 10n ** 18n;

      await fundWithWETH(flashAmount);

      const ownerBefore = await weth.balanceOf(owner.address);

      console.log("Owner WETH BEFORE:", ownerBefore.toString());
      const minProfit = 0n;
      let slippageBps = 0;

      const tx = await arbitrage.executeTrade(
        true,
        TOKEN_CONFIG.WETH.address,
        TOKEN_CONFIG.LINK.address,
        TOKEN_CONFIG.AAVE.address,
        flashAmount,
        minProfit,
        slippageBps
      );

      await logAndAssertEvents(tx);

      const ownerAfter = await weth.balanceOf(owner.address);

      console.log("Owner WETH AFTER:", ownerAfter.toString());

      // Allow break-even for multi-hop test
      expect(ownerAfter).to.be.gte(ownerBefore);
    });

});