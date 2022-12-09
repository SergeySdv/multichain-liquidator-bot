import BigNumber from "bignumber.js";
import { calculateOutputXYKPool, calculateRequiredInputXYKPool } from "./math.js";
import { RouteHop } from "./types/RouteHop";
import { Pool } from "./types/Pool";

const BASE_ASSET_INDEX = 0
const QUOTE_ASSET_INDEX = 1

export interface AMMRouterInterface {
  getRoutes(tokenInDenom: string, tokenOutDenom: string) : RouteHop[][]
}

/**
 * Router provides a route to swap between any two given assets.
 * 
 */
export class AMMRouter implements AMMRouterInterface {
    private pools: Pool[] 
    constructor() {
        this.pools = []
    }

    setPools(pools: Pool[]) {
      this.pools = pools
    }

    /**
     * Calculates the expected output of `tokenOutDenom` using the given route
     * @param tokenInAmount 
     * @param route 
     * @return The estimated amount of asset we think we will recieve
     */
    getEstimatedOutput(tokenInAmount: BigNumber, route: RouteHop[]): BigNumber {

      let amountAfterFees = new BigNumber(0)

      if(tokenInAmount.isEqualTo(0)) {
        console.log("ERROR - cannot use token in amount of 0")
        return amountAfterFees
      }

      // for each hop
      route.forEach((routeHop) => {
        const amountBeforeFees = calculateOutputXYKPool(new BigNumber(routeHop.x1), new BigNumber(routeHop.y1), new BigNumber(tokenInAmount))
        amountAfterFees = amountBeforeFees.minus(amountBeforeFees.multipliedBy(routeHop.swapFee))
        tokenInAmount = amountAfterFees
      })

      return amountAfterFees
    }

    // todo hea
    getEstimatedRequiredInput(tokenOutRequired: BigNumber, route: RouteHop[]) : BigNumber {
      let amountAfterFees = new BigNumber(0)

      if(tokenOutRequired.isEqualTo(0)) {
        console.log("ERROR - cannot use token out amount of 0")
        return amountAfterFees
      }

      // for each hop
      route.forEach((routeHop) => {
        const amountInBeforeFees = calculateRequiredInputXYKPool(new BigNumber(routeHop.x1), new BigNumber(routeHop.y1), new BigNumber(tokenOutRequired))
        amountAfterFees = amountInBeforeFees.plus(tokenOutRequired.multipliedBy(routeHop.swapFee))
        tokenOutRequired = amountAfterFees
      })

      return amountAfterFees
    }

    getRoutes(tokenInDenom: string, tokenOutDenom: string) : RouteHop[][] {
        return this.buildRoutesForTrade(tokenInDenom, tokenOutDenom, this.pools, [], [])
    }

    // We want to list all assets in the route except our last denom (tokenOutDenom)
    private findUsedPools = (route : RouteHop[]) : Long[] => {
      return route.map((hop) => hop.poolId)
    }

    private buildRoutesForTrade(
      tokenInDenom: string, 
      targetTokenOutDenom:string, 
      pools: Pool[], 
      route : RouteHop[], 
      routes: RouteHop[][]): RouteHop[][] {

        // we don't want to search through the same pools again and loop, so we delete filter pools that 
        // exist in the route
        const usedPools = this.findUsedPools(route)
        
        // all pairs that have our sell asset, and are not previously in our route
        const possibleStartingPairs = pools.filter(
          (pool) => {
            return ((
            pool.poolAssets[BASE_ASSET_INDEX].denom === tokenInDenom || 
            pool.poolAssets[QUOTE_ASSET_INDEX].denom === tokenInDenom) 
            // ensure we don't use the same pools
            && usedPools.find((poolId) => pool.id === poolId) === undefined)
          })

        // no more possible pools then we exit
        if (possibleStartingPairs.length === 0) {
          return routes
        }

        // if we find an ending par(s), we have found the end of our route
        const endingPairs = possibleStartingPairs.filter(
          (pool) => pool.poolAssets[BASE_ASSET_INDEX].denom === targetTokenOutDenom ||
            pool.poolAssets[QUOTE_ASSET_INDEX].denom === targetTokenOutDenom)
      
        if (endingPairs.length > 0 && tokenInDenom !== targetTokenOutDenom) {
          endingPairs.forEach((pool) => {
            const hop  : RouteHop = {
              poolId: pool.id,
              tokenInDenom: tokenInDenom,
              tokenOutDenom: targetTokenOutDenom,
              swapFee: Number(pool.swapFee || '0'),
              x1 : new BigNumber(pool.poolAssets.find((poolAsset)=>poolAsset.denom===tokenInDenom)?.amount!),
              y1 : new BigNumber(pool.poolAssets.find((poolAsset)=>poolAsset.denom===targetTokenOutDenom)?.amount!)
            }

            // deep copy the array
            const routeClone : RouteHop[] = JSON.parse(JSON.stringify(route))
            routeClone.push(hop)
            routes.push(routeClone)
          })

          // return routes
        }
      
        // Else, we have not found the route. Iterate recursively through the pools building valid routes. 
        possibleStartingPairs.forEach((pool) => {
          const base = pool.poolAssets[BASE_ASSET_INDEX]
          const quote = pool.poolAssets[QUOTE_ASSET_INDEX]

          // We have no garauntee that index [0] will be the token in so we need to calculate that ourselves
          const tokenOut = tokenInDenom === base.denom ? quote : base
          const tokenIn = tokenOut === base ? quote! : base!

          const nextHop : RouteHop = {
            poolId:pool.id,
            tokenInDenom,
            tokenOutDenom: tokenOut.denom,
            swapFee: Number(pool.swapFee || 0),
            x1 : new BigNumber(tokenIn.amount),
            y1 : new BigNumber(tokenOut.amount)
          }

          // deep copy so we don't mess up other links in the search
          const newRoute : RouteHop[] = JSON.parse(JSON.stringify(route))

          newRoute.push(nextHop)

          this.buildRoutesForTrade(tokenOut.denom!, targetTokenOutDenom, pools, newRoute, routes)
        })

        return routes
    }

   

}