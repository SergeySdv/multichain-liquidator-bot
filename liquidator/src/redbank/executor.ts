import { LiquidationHelper } from '../liquidation_helpers.js'

import { LiquidationResult, LiquidationTx } from '../types/liquidation.js'
import { Position } from '../types/position'
import { toUtf8 } from '@cosmjs/encoding'
import { Coin, SigningStargateClient } from '@cosmjs/stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx.js'
import { coins, DirectSecp256k1HdWallet, EncodeObject } from '@cosmjs/proto-signing'

import {
  makeBorrowMessage,
  makeDepositMessage,
  makeExecuteContractMessage,
  makeRepayMessage,
  makeWithdrawMessage,
  ProtocolAddresses,
  repay,
  sleep,
} from '../helpers.js'
import { osmosis, cosmwasm } from 'osmojs'

import 'dotenv/config.js'
import { Collateral, DataResponse, Debt, fetchRedbankBatch } from '../hive.js'
import { IRedisInterface, RedisInterface } from '../redis.js'
import BigNumber from 'bignumber.js'
import { Long } from 'osmojs/types/codegen/helpers.js'
import { BaseExecutor, BaseExecutorConfig } from '../BaseExecutor.js'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { getLargestCollateral, getLargestDebt } from '../liquidation_generator.js'

const { swapExactAmountIn } = osmosis.gamm.v1beta1.MessageComposer.withTypeUrl

const { executeContract } = cosmwasm.wasm.v1.MessageComposer.withTypeUrl

export interface RedbankExecutorConfig extends BaseExecutorConfig {
  liquidationFiltererAddress: string
  liquidatableAssets: string[]
}

/**
 * Executor class is the entry point for the executor service
 *
 * @param sm An optional parameter. If you want to use a secret manager to hold the seed
 *           phrase, implement the secret manager interface and pass as a dependency.
 */
export class Executor extends BaseExecutor {
  
  public config : RedbankExecutorConfig
  private liquidationHelper: LiquidationHelper

  constructor(config: RedbankExecutorConfig, client: SigningStargateClient, queryClient: CosmWasmClient) {
    super(config, client, queryClient)
    this.config = config
    
    // instantiate liquidation helper
    this.liquidationHelper = new LiquidationHelper(
      this.config.liquidatorMasterAddress,
      this.config.liquidationFiltererAddress,
    )
  }

  async start() {
    await this.initiate()

    // run
    while (true) {
      try {
        await this.run()
      } catch (e) {
        console.log('ERROR:', e)
      }
    }
  }

  produceLiquidationTxs(
    positionData: DataResponse[]
  ): {
    txs: LiquidationTx[]
    debtsToRepay: Map<string, BigNumber>
  } {
    const txs: LiquidationTx[] = []
    const debtsToRepay = new Map<string, BigNumber>()

    let totalDebtValue = BigNumber(0)
    const availableValue = new BigNumber(this.balances.get(this.config.neutralAssetDenom) || 0).multipliedBy(this.prices.get(this.config.neutralAssetDenom) || 0)

    // create a list of debts that need to be liquidated
    positionData.forEach(async (positionResponse: DataResponse) => {
      const positionAddress = Object.keys(positionResponse.data)[0]
      const position = positionResponse.data[positionAddress]

      if (position.collaterals.length > 0 && position.debts.length > 0) {

        const largestCollateralDenom = getLargestCollateral(position.collaterals, this.prices)
        const largestDebt = getLargestDebt(position.debts, this.prices)

        // total debt value is calculated in base denom (i.e uosmo)
        const remainingAvailableSize = availableValue.minus(totalDebtValue)
        
        if (remainingAvailableSize.isGreaterThan(100)) {

          // we will always have a value here as we filter for the largest above
          const debtPrice = this.prices.get(largestDebt.denom)!

          const debtValue = new BigNumber(largestDebt.amount).multipliedBy(debtPrice)

          // Note -amount here is the number of the asset, not the value !
          const amountToLiquidate = remainingAvailableSize.isGreaterThan(debtValue) ? largestDebt.amount : remainingAvailableSize.dividedBy(debtPrice).toFixed(0)
          
          const liquidateTx = {
            collateral_denom: largestCollateralDenom,
            debt_denom: largestDebt.denom,
            user_address: positionAddress,
            amount: amountToLiquidate,
          }

          

          const newTotalDebt = totalDebtValue.plus(new BigNumber(amountToLiquidate).multipliedBy(debtPrice))
          txs.push(liquidateTx)

          // update debts + totals
          const existingDebt = debtsToRepay.get(liquidateTx.debt_denom) || 0
          debtsToRepay.set(liquidateTx.debt_denom, new BigNumber(amountToLiquidate).plus(existingDebt))
          totalDebtValue = newTotalDebt
        } else {
          console.warn(
            `WARNING - not enough size to liquidate this position - user address : ${[positionAddress]}`
          )
        }
      }
    })

    return { txs, debtsToRepay }
  }

  produceBorrowTxs(
    debtsToRepay: Map<string, BigNumber>,
    liquidationHelper: LiquidationHelper,
  ): EncodeObject[] {

    const borrowTxs: EncodeObject[] = []
    debtsToRepay.forEach((amount, denom) =>
      borrowTxs.push(
        makeBorrowMessage(
          liquidationHelper.getLiquidatorAddress(),
          denom,
          amount.toFixed(0),
          this.config.redbankAddress,
        ),
      ),
    )
    return borrowTxs
  }

  appendWithdrawMessages(
    collateralsWon: Collateral[],
    liquidatorAddress: string,
    msgs: EncodeObject[],
  ) {
    // for each asset, create a withdraw message
    collateralsWon.forEach((collateral) => {
      const denom = collateral.denom
        msgs.push(
          executeContract(
            makeWithdrawMessage(liquidatorAddress, denom, this.config.redbankAddress)
              .value as MsgExecuteContract,
          ),
        )
    })

    return msgs
  }

  appendSwapToNeutralMessages(coins: Coin[], liquidatorAddress: string, msgs: EncodeObject[]) : BigNumber {
    let expectedNeutralCoins = new BigNumber(0)
    coins
      .filter((collateral) => collateral.denom !== this.config.neutralAssetDenom)
      .forEach((collateral) => {
        let collateralAmount =
          collateral.denom === this.config.gasDenom
            ? new BigNumber(collateral.amount).minus(100000000) // keep min 100 tokens for gas
            : new BigNumber(collateral.amount)

        if (collateralAmount.isGreaterThan(1000) && !collateralAmount.isNaN()) {
          const routeOptions = this.ammRouter.getRoutes(collateral.denom, this.config.neutralAssetDenom)

          const bestRoute = routeOptions
            .sort((routeA, routeB) => {
              const routeAReturns = this.ammRouter.getOutput(collateralAmount, routeA)
              const routeBReturns = this.ammRouter.getOutput(collateralAmount, routeB)
              return routeAReturns.minus(routeBReturns).toNumber()
            })
            .pop()

          if (bestRoute) {
            // allow for 2.5% slippage from what we estimated
            const minOutput = this.ammRouter
              .getOutput(new BigNumber(collateralAmount), bestRoute)
              .multipliedBy(0.975)
              .toFixed(0)

            expectedNeutralCoins = expectedNeutralCoins.plus(minOutput)
            msgs.push(
              swapExactAmountIn({
                sender: liquidatorAddress,
                // cast to long because osmosis felt it neccessary to create their own Long rather than use the js one
                routes: bestRoute?.map((route) => {
                  return { poolId: route.poolId as Long, tokenOutDenom: route.tokenOutDenom }
                }),
                tokenIn: { denom: collateral.denom, amount: Number(collateralAmount).toFixed(0) },
                tokenOutMinAmount: minOutput,
              }),
            )
          }
        }
      })

    return expectedNeutralCoins
  }

  appendSwapToDebtMessages(
    debtsToRepay: Coin[],
    liquidatorAddress: string,
    msgs: EncodeObject[],
    neutralAvailable: BigNumber
    // min available stables?
  ) {
    let remainingNeutral = neutralAvailable
    const expectedDebtAssetsPostSwap : Map<string, BigNumber> = new Map()

    debtsToRepay.forEach((debt) => {
      const debtAmountRequiredFromSwap = new BigNumber(debt.amount)
      if (debtAmountRequiredFromSwap.isGreaterThan(1000)) {
        
        if (debt.denom === this.config.neutralAssetDenom) {
          const cappedAmount = remainingNeutral.isLessThan(debt.amount) ? remainingNeutral : new BigNumber(debt.amount)
          remainingNeutral = neutralAvailable.minus(cappedAmount.minus(1))

          const totalDebt = cappedAmount.plus(expectedDebtAssetsPostSwap.get(debt.denom) || 0)
          expectedDebtAssetsPostSwap.set(debt.denom, totalDebt)
        } else {
          const routeOptions = this.ammRouter.getRoutes(this.config.neutralAssetDenom, debt.denom)

          const bestRoute = routeOptions
            .sort((routeA, routeB) => {
              const routeAReturns = this.ammRouter.getRequiredInput(
                debtAmountRequiredFromSwap,
                routeA,
              )
              const routeBReturns = this.ammRouter.getRequiredInput(
                debtAmountRequiredFromSwap,
                routeB,
              )
              return routeAReturns.minus(routeBReturns).toNumber()
            })
            .pop()
  
          if (bestRoute) {
  
            const amountToSwap = this.ammRouter.getRequiredInput(
              // we add a little more to ensure we get enough to cover debt
              debtAmountRequiredFromSwap.multipliedBy(1.025), 
              bestRoute,
            )
  
            // if amount to swap is greater than the amount available, cap it
            const cappedSwapAmount = remainingNeutral.isLessThan(amountToSwap) ? remainingNeutral : amountToSwap
  
            // the min amount of debt we want to recieve
            const minDebtOutput = this.ammRouter.getOutput(cappedSwapAmount, bestRoute).multipliedBy(0.98)
  
            // take away 1 to avoid rounding errors / decimal places overshooting.
            remainingNeutral = neutralAvailable.minus(cappedSwapAmount.minus(1)) 
  
            const totalDebt = minDebtOutput.plus(expectedDebtAssetsPostSwap.get(debt.denom) || 0)
  
            expectedDebtAssetsPostSwap.set(debt.denom, totalDebt)
  
            msgs.push(
              swapExactAmountIn({
                sender: liquidatorAddress,
                routes: bestRoute?.map((route) => {
                  return { poolId: route.poolId as Long, tokenOutDenom: route.tokenOutDenom }
                }),
                tokenIn: { denom: this.config.neutralAssetDenom, amount: amountToSwap.toFixed(0) },
                // allow for 1% slippage for debt what we estimated
                tokenOutMinAmount: minDebtOutput.toFixed(0),
              }),
            )
        }
        }
      }
    })

    return expectedDebtAssetsPostSwap
  }

  appendRepayMessages(
    debtsToRepay: Debt[],
    liquidatorAddress: string,
    msgs: EncodeObject[],
    expectedDebtAssetAmounts: Map<string, BigNumber>
  ): EncodeObject[] {

    debtsToRepay.forEach((debt) => {
      // Cap the amount we are repaying by the amount available
      const debtAvailable = expectedDebtAssetAmounts.get(debt.denom) || new BigNumber(0)
      const debtToRepay = debtAvailable.isGreaterThan(debt.amount) ? new BigNumber(debt.amount) : debtAvailable
      if (debtToRepay.isGreaterThan(1000)) {
        msgs.push(
          makeRepayMessage(liquidatorAddress, this.config.redbankAddress, [
            {
              denom: debt.denom,
              amount: debtToRepay.toFixed(0),
            },
          ]),
        )
      }
    })

    return msgs
  }

  appendDepositMessages(liquidatorAddress: string, msgs: EncodeObject[]): EncodeObject[] {
    const balance = this.balances.get(this.config.neutralAssetDenom)

    if (!balance || balance === 0) return msgs
    msgs.push(
      makeDepositMessage(liquidatorAddress, this.config.neutralAssetDenom, this.config.redbankAddress, [
        { denom: this.config.neutralAssetDenom, amount: balance.toFixed(0) },
      ]),
    )

    return msgs
  }

  async run() {
    const liquidatorAddress = this.config.liquidatorMasterAddress

    if (!this.queryClient || !this.client)
      throw new Error("Instantiate your clients before calling 'run()'")


    await this.refreshData()

    // refresh our balances
    await this.setBalances(liquidatorAddress)

    console.log('Checking for liquidations')
    const positions: Position[] = await this.redis.popUnhealthyRedbankPositions(25)

    if (positions.length == 0) {
      //sleep to avoid spamming redis db when empty
      await sleep(200)
      console.log(' - No items for liquidation yet')
      return
    }

    // Fetch position data
    const positionData: DataResponse[] = await fetchRedbankBatch(
      positions,
      this.config.redbankAddress,
      this.config.hiveEndpoint,
    )

    console.log(`- found ${positionData.length} positions queued for liquidation.`)

    // // fetch debts, liquidation txs
    const { txs, debtsToRepay } = this.produceLiquidationTxs(positionData)
    
    const debtCoins: Coin[] = []
    debtsToRepay.forEach((amount, denom) => debtCoins.push({ denom, amount: amount.toFixed(0) }))

    // deposit any neutral in our account before starting liquidations
    const firstMsgBatch : EncodeObject[] = []
    const assetsRecieved = this.appendSwapToDebtMessages(debtCoins,liquidatorAddress, firstMsgBatch, new BigNumber(this.balances.get(this.config.neutralAssetDenom)!))
    const coinsFromSwap : Coin[] = []
    assetsRecieved.forEach((amount, denom) => coinsFromSwap.push({denom, amount: amount.toFixed(0)}))

    const liquidateMsg = JSON.stringify({ liquidate_many: { liquidations: txs } })
    const msg = toUtf8(liquidateMsg)

    firstMsgBatch.push(
      executeContract(
        makeExecuteContractMessage(
          this.liquidationHelper.getLiquidatorAddress(),
          this.liquidationHelper.getLiquidationFiltererContract(),
          msg,
          coinsFromSwap,
        ).value as MsgExecuteContract,
      ),
    )

    if (!firstMsgBatch || firstMsgBatch.length === 0 ||txs.length === 0) return []

    const result = await this.client.signAndBroadcast(
      this.liquidationHelper.getLiquidatorAddress(),
      firstMsgBatch,
      await this.getFee(firstMsgBatch, this.liquidationHelper.getLiquidatorAddress()),
    )


    // redis.incrementBy('executor.liquidations.executed', results.length)

    console.log(`- Successfully liquidated ${txs.length} positions`)

    const collaterals: Collateral[] = await this.queryClient?.queryContractSmart(
      this.config.redbankAddress,
      { user_collaterals: { user: liquidatorAddress } },
    )

    // second block of transactions
    let secondBatch: EncodeObject[] = []

    const balances = await this.client?.getAllBalances(liquidatorAddress)

    const combinedCoins = this.combineBalances(collaterals, balances!)

    this.appendWithdrawMessages(collaterals, liquidatorAddress, secondBatch)

    this.appendSwapToNeutralMessages(
      combinedCoins, 
      liquidatorAddress, 
      secondBatch)
 
    await this.client.signAndBroadcast(
      this.config.liquidatorMasterAddress,
      secondBatch,
      await this.getFee(secondBatch, this.config.liquidatorMasterAddress),
    )

    await this.setBalances(liquidatorAddress)

    txs.forEach((tx)=> {
      this.addCsvRow({
        blockHeight: result.height,
        collateral: tx.collateral_denom,
        debtRepaid: tx.debt_denom,
        estimatedLtv: '0',
        userAddress: tx.user_address,
        liquidatorBalance: Number(this.balances.get(this.config.neutralAssetDenom) || 0)
      })
    })
    
    console.log(`- Liquidation Process Complete.`)

    this.writeCsv()
  }

  combineBalances(collaterals: Collateral[], balances: readonly Coin[]): Coin[] {
    const coinMap: Map<string, Coin> = new Map()

    collaterals.forEach((collateral) =>
      coinMap.set(collateral.denom, {
        denom: collateral.denom,
        amount: Number(collateral.amount).toFixed(0),
      }),
    )

    balances.forEach((balance) => {
      const denom = balance.denom
      const amount = balance.amount
      const existingBalance = coinMap.get(denom)?.amount || 0
      const newBalance = (Number(existingBalance) + Number(amount)).toFixed(0)
      const newCoin = { denom, amount: newBalance }
      coinMap.set(denom, newCoin)
    })

    const result: Coin[] = []
    coinMap.forEach((coin) => result.push(coin))
    return result
  }

  sendBorrowAndLiquidateTx = async (
    txs: LiquidationTx[],
    borrowMessages: EncodeObject[],
    coins: Coin[],
    liquidationHelper: LiquidationHelper,
  ): Promise<LiquidationResult[]> => {
    if (!this.client)
      throw new Error(
        'Stargate Client is undefined, ensure you call initiate at before calling this method',
      )

    const liquidateMsg = JSON.stringify({ liquidate_many: { liquidations: txs } })
    const msg = toUtf8(liquidateMsg)
    const msgs: EncodeObject[] = borrowMessages

    msgs.push(
      executeContract(
        makeExecuteContractMessage(
          liquidationHelper.getLiquidatorAddress(),
          liquidationHelper.getLiquidationFiltererContract(),
          msg,
          coins,
        ).value as MsgExecuteContract,
      ),
    )

    if (!msgs || msgs.length === 0) return []

    const result = await this.client.signAndBroadcast(
      liquidationHelper.getLiquidatorAddress(),
      msgs,
      await this.getFee(msgs, liquidationHelper.getLiquidatorAddress()),
    )

    if (!result || !result.rawLog) return []
    
    const collaterals: Collateral [] = await this.queryClient?.queryContractSmart(
      this.config.redbankAddress,
      { user_collaterals: { user: this.config.liquidatorMasterAddress } },
    )

    const usdcCollateral = collaterals.find((collateral) => collateral.denom === 'usdc')

    txs.forEach((tx) => {
      this.addCsvRow({
        blockHeight: result.height,
        collateral: tx.collateral_denom,
        debtRepaid: tx.debt_denom,
        userAddress: tx.user_address,
        estimatedLtv: '0.99',
        liquidatorBalance: Number(usdcCollateral?.amount)
      })
    })
    
    const events = JSON.parse(result.rawLog)[0]

    return liquidationHelper.parseLiquidationResult(events.events)
  }
  getFee = async (msgs: EncodeObject[], address: string) => {
    if (!this.client)
      throw new Error(
        'Stargate Client is undefined, ensure you call initiate at before calling this method',
      )
    const gasEstimated = await this.client.simulate(address, msgs, '')
    const fee = {
      amount: coins(60000, 'uosmo'),
      gas: Number(gasEstimated * 1.3).toFixed(0),
    }

    return fee
  }
}
