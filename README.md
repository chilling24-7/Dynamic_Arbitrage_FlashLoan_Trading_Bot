# Trading Bot Demo

## Description
This bot is designed to be a Dynamic Arbitrage Flash Loan trading bot. This trading bot leverages an **arbitrage strategy** to detect and profit from price differences between two decentralized exchanges: **Uniswap** and **Sushiswap**. The bot continuously monitors swap events, calculates potential profits, and executes trades through a smart contract to take advantage of price discrepancies. The tokens it monitors is from the topTokens.js file, you can add tokens to it and make list bigger. This bot is designed to take out a **Flash Loan** from Balancer using WETH. This bot does have code in it do a 3 token arb, but due to problems, most of the code was taken out, some of it remains so if a 3 token ARB is desired, some changes can be done to make that happen. 

### How It Works:
1. The bot listens for **swap events** from both **Uniswap** and **Sushiswap**.
2. When a swap event is detected, the bot checks the current prices on both exchanges.
3. If the price difference meets the required threshold, the bot calculates potential profit and determines the best trading direction.
4. The bot executes the arbitrage trade on the exchanges by leveraging a **flash loan**.
5. It transfers any profit to the owner's wallet and continues monitoring for further opportunities.

### Purpose:
This bot is designed to automate arbitrage trading, which involves buying an asset on one exchange at a lower price and selling it on another exchange at a higher price. The goal is to make a profit from the price difference without requiring any initial capital, using **flash loans** to facilitate trades.

### Author's Notes:
I learned how to make an Arbitrage Flash Loan Trading Bot. I then took it a step farther to do a Dynamic Arbitrage Flash Loan trading bot that will scan multiple tokens. The goal was to go from a 1 to 1 swap to 1 to Many strategy. This bot will do trades between the WETH token and any other token that is in the list. I spent alot of time getting this to work, it works fine on local host and I am currently Forking on Mainnet. So in theory, it should work if on live network. 

As for why I am doing this, I took a class at DAPP Univeristy about being a Block Chain Developer and it gave me alot of knowledge on the Block Chain. It also mentioned about how to use or make an Arbitrage Flash Loan Trading Bot. I downloaded there Bot and tried to make it work, but had problems. It worked somewhat but needed alot of tweeking. 

I then used AI (ChatGPT) at https://chatgpt.com/ to make changes and make it work on a Local Node or Local Block Chain on my computer. I wanted to go farther with the bot and make it a professional MEV bot, but it seems I need to go in steps to get more knowledge and understanding on how it works. I have learned that using AI, the possiblities are limitless if you put in the time and effort, but AI is flawed and I spend alot of time debugging or fixing what code it writes. 

With the way the world is going, I wanted to share what I did and show what I have learned and maybe inspire of help other developers get out of the current financial system or find other ways to support themselves. I want to let everyone who wants to trade crypto using flash loans have that opportunity or at least know where to start and show that it can be done. The way I see it, we are all in this world together and we need to help each other and give people ideas or ways to get by in this world since there are alot of people trying to take away peoples freedoms and rights. This is one way to fight back.

---

## Technology Stack & Tools

- Solidity (Writing Smart Contract)
- Javascript (React & Testing)
- [Hardhat](https://hardhat.org/) (Development Framework)
- [Ethers.js](https://docs.ethers.io/v5/) (Blockchain Interaction)
- [Alchemy](https://www.alchemy.com/) (Blockchain Connection)
- [Balancer](https://balancer.fi/) (Flash Loan Provider)

## Requirements For Initial Setup
- Install [NodeJS](https://nodejs.org/en/). We recommend using the latest LTS (Long-Term-Support) version, and preferably installing NodeJS via [NVM](https://github.com/nvm-sh/nvm#intro).
- Create an [Alchemy](https://www.alchemy.com/) account, you'll need to create an app for the Ethereum chain, on the mainnet network

## Setting Up a new Project
### 1. Clone/Download the Repository
git clone https://github.com/chilling24-7/Dynamic_Arbitrage_FlashLoan_Trading_Bot.git

### 2. Install Dependencies:

Start a new project:
- npx hardhat --init

Start hardhat v2 (older version)

Install HardHat version 2:
- npm install --save-dev hardhat@^2.0.0

Install a Specific version 2:
- npm install --save-dev hardhat@2.10.0 

Install NVM:
- nvm install 22.10.0
- nvm use 22

Then install ethers:
- npm install ethers@6

npx hardhat compile (should work) 
Will need to create a .env file with the needed variables. 

Then install may be needed, but have worked without doing it:
- npm install --save-dev @nomicfoundation/hardhat-ethers

List of other dependencies that are needed:
- npm install --save-dev \
	@openzeppelin/contracts@4.9.6 \
	@uniswap/v2-core@1.0.1 \
	@uniswap/v2-periphery@1.1.0-beta.0 \
	@balancer-labs/v2-interfaces@0.4.0 \
	@nomicfoundation/hardhat-toolbox@6.1.2 \
	hardhat@2.28.6

Optional if you want to try making the bot be a backrunner: 

Then install this to allow backrunner bundles:
- npm install @flashbots/ethers-provider-bundle or yarn add @flashbots/ethers-provider-bundle or npm install ethers@6 @flashbots/ethers-provider-bundle

To remove or uninstall:
- npm uninstall @flashbots/ethers-provider-bundle (if you need to remove it)

### 3. Create and Setup .env
Before running any scripts, you'll want to create a .env file with the following values (see .env.example):

# Tokens to arbitrage
ARB_FOR=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2   # WETH
ARB_AGAINST=0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32  # LDO
#ARB_AGAINST=0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE  # SHIB
ARB_THIRD=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Needed Variables
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
USDT=0xdAC17F958D2ee523a2206206994597C13D831ec7
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
DAI=0x6B175474E89094C44Da98b954EedeAC495271d0F

WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
DAI_ADDRESS=0x6B175474E89094C44Da98b954EedeAC495271d0F
VAULT_ADDRESS=0xBA12222222228d8Ba445958a75a0704d566BF2C8

# Router Variables
SUSHI_ROUTER=0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F
UNI_ROUTER=0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D

# Minimum Profit limit
MIN_PROFIT_USDC=5

# Price difference threshold (%) for executing arbitrage
PRICE_DIFFERENCE=0.50

# Number of decimals to display for prices
UNITS=15

# Gas configuration
GAS_LIMIT=400000
GAS_PRICE=0.00000006

# Private key of the wallet executing trades
PRIVATE_KEY=""

# Alchemy / Infura API key for provider
ALCHEMY_API_KEY="-"

# RPC Provider
LOCAL_RPC_URL=http://127.0.0.1:8545
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/ALCHEMY_API_KEY

### 4. Start Hardhat Node:
In your terminal run:
`npx hardhat node`

Once you've started the hardhat node, copy the private key of the first account as you'll need to paste it in your .env file in the next step.

*As a reminder, do **NOT** use or fund the accounts/keys provided by the hardhat node in a real production setting, they are to be only used in your local testing!*

### 5. Add Private Key to .env
Copy the private key of the first account provided from the hardhat node, and paste in the value for the **PRIVATE_KEY** variable in your .env file

### 6. Deploy Smart Contract
In a separate terminal run:
`npx hardhat run scripts/deploy.js --network localhost`

Sometimes the deployed address may be different when testing, and therefore you'll need to update the **ARBITRAGE_ADDRESS** inside of the *config.json* 

### 7. Start the Bot
`node bot.js`

### 8. Manipulate Price by doing a token Pump or Dump
In another terminal run:
`npx hardhat run scripts/singleTokenPump.js --network localhost` 
`npx hardhat run scripts/singleTokenDump.js --network localhost

## About config.json
Inside the *config.json* file, under the PROJECT_SETTINGS object, there are 3 keys that hold a boolean value:
- isLocal
- isDeployed
- SIMULATE_TRADES

All options depend on how you wish to test the bot. By default the values are set to true. If you set isLocal to false, and then run the bot this, will allow the bot to monitor swap events on the actual mainnet, instead of locally. 

isDeployed's value can be set on whether you wish for the abritrage contract to be called if a potential trade is found. By default isDeployed is set to true for local testing. Ideally this is helpful if you want to monitor swaps on mainnet and you don't have a contract deployed. This will allow you to still experiment with finding potential abitrage opportunites. 

SIMULATE_TRADES will allow you simulate trades either on a Local Network or Mainnet or other networks. The bot will not use a 
flash loan if set to true, it will simulate a flash loan. If set to False, then it will do a REAL Flash loan if not on a local network. 

## Testing Bot on Mainnet
For monitoring prices and detecting potential arbitrage opportunities, you do not need to deploy the contract. 

### 1. Edit config.json
Inside the *config.json* file, set **isDeployed** to **false** and **isLocal** to **false** and **SIMULATE_TRADES** to true

### 2. Create and Setup .env
See step #4 in **Setting Up**

### 3. Run the bot
`node bot.js`

Keep in mind you'll need to wait for an actual swap event to be triggered before it checks the price.

## Anatomy of bot.js
The bot is essentially composed of 5 functions.
- *main()*
- *swapEvent()*
- *determineDirection()*
- *determineProfitability()*
- *executeTrade()*

The *main()* function monitors swap events from both Uniswap & Sushiswap. 

When a swap event occurs, it calls *swapEvent()*, this function will call the other functions and will do a prefilter on the liquidity and reserves, if good, call the next function. 

Then *determineDirection()* is called, this will determine where we would need to buy first, then sell. This function will determine the router paths, reserves, token spread difference and tradePath. If all are in good ranges, then it will return needed information for the next function to calculate profit. 

If the ranges are good, *swapEvent()* will call *determineProfitability()*. This is where we set our conditions on whether there is a potential arbitrage or not. This function returns either true or false.

If true is returned from *determineProfitability()*, then we call *executeTrade()* where we make our call to our arbitrage contract to perform the trade. Afterwards a report is logged, and the bot resumes to monitoring for swap events.

### Modifying & Testing the Scripts
Both the *singleTokenPump.js*, singleTokenDump.js and *bot.js* has been setup to easily make some modifications easy. The test scripts are written so no changes are needed unless you want to test different tokens. That can be modified at the bottom of the tests. Each test does a different type of trade, one will Pump up a token price, the other will lower a token price. 


### Additional Information
The *bot.js* script uses helper functions for fetching token pair addresses, calculating price of assets, and calculating estimated returns. These functions can be found in the *helper.js* file inside of the helper folder.

The helper folder also has *server.js* which is responsible for spinning up a local server, and *initialization.js* which is responsible for setting up our blockchain connection, configuring Uniswap/Sushiswap contracts, etc. 

As you customize parts of the script it's best to refer to [Uniswap documentation](https://docs.uniswap.org/contracts/v2/concepts/protocol-overview/how-uniswap-works) for a more detail rundown on the protocol and interacting with the V2 exchange.

### Strategy Overview and Potential Errors
The current strategy implemented is only shown as an example alongside with the *manipulate.js* script. After we manipulate price on Uniswap, we fetch the reserves on Uniswap & Sushiswap and determine the lower SHIB amount by dividing the lower amount by half. Based off of the strategy you plan and test, dividing by half may not be the most optimal. You will need to play around with your strategy. We recommend looking into how Uniswap V2 reserves work, in addition to how getAmountsIn & getAmountsOut work:

- [getReserves](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/pair#getreserves)
- [getAmountsOut](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/library#getamountsout)
- [getAmountsIn](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/library#getamountsin)

In the case of error handling, *determineProfitability()* currently has a try/catch implemented. Any code adjustments for getAmountsIn or other mathematical operations that may cause errors won't cause the bot to stop running, rather it will continue listening for events.

## Using other EVM chains
If you are looking to test on an EVM compatible chain, you can follow these steps:

### 1. Update .env file, this file has many variables in it, but ARB_FOR and ARB_AGAINST are not used, but still there. 

- **ARB_FOR=""** 
- **ARB_AGAINST=""**

Token addresses will be different on different chains, you'll want to reference blockchain explorers such as [Polyscan](https://polygonscan.com/) for Polygon for token addresses you want to test.

### 2. Update config.json

- **V2_ROUTER_02_ADDRESS=""** 
- **FACTORY_ADDRESS=""**

You'll want to update the router and factory addresses inside of the *config.json* file with the V2 exchanges you want to use. Based on the exchange you want to use, refer to the documentation for it's address.

### 3. Change RPC URL

Inside of *initialization.js*, you'll want to update the websocket RPC URL. Example of Polygon:
```
provider = new hre.ethers.providers.WebSocketProvider(`wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`)
```

Inside of *hardhat.config.js*, you'll want to update the forking URL. Example of Polygon:
```
url: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
```

### 4. Changing Arbitrage.sol
You may also need to change the flashloan provider used in the contract to one that is available on your chain of choice. Currently Balancer seems to support the following chains:
- Ethereum Mainnet
- Arbitrum
- Optimism
- Polygon
- Gnosis
- Avalanche
- Goerli (Testnet)
- Sepolia (Testnet)

Be sure to check their documentation for latest updates regarding their contracts and deployment addresses:
- [Balancer Documentation](https://docs.balancer.fi/)
- [Balancer Flash Loans](https://docs.balancer.fi/guides/arbitrageurs/flash-loans.html) 

### Additional Notes

- All tests should work, but some variables may need to be adjusted like threshold
