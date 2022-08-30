package health_checker

import (
	"fmt"
	"testing"
)

// TODO : Do setup here, not rely on deploy scripts
func Test_weCanQueryMultipleUsers(t *testing.T) {

	hiveEndpoint := "https://osmosis-testnet-hive.herokuapp.com/graphql"
	redbankAddress := "osmo1mx2redehm4dtmwkfq3399k8ly2skfyqzfzg9clelw4enuuhtfeeq3dk9kj"
	batchSize := 200

	mockPosition := Position{
		Address:    "osmo18nm43hck80s2et26g2csvltecvhk49526dugd9",
		Debts:      []Asset{},
		Collateral: []Asset{},
	}

	positions := []Position{}

	for i := 1; i <= batchSize; i++ {
		positions = append(positions, mockPosition)
	}

	hive := Hive{hiveEndpoint}

	result, err := hive.FetchBatch(redbankAddress, positions)

	if err != nil {
		t.Errorf("Error occured during request: %s", err)
	}

	expectedLength := len(positions)
	actualLength := len(result)
	if expectedLength != actualLength {
		t.Errorf("Length was incorrect. Expected %d but got %d", expectedLength, actualLength)
	}
	fmt.Println(result[0])
	intLTV := 0
	fmt.Sscan(result[batchSize/2].ContractQuery.HealthStatus.Borrowing, &intLTV)
	if intLTV <= 0 {
		t.Errorf("Failed to correctly fetch health factor")
	}
}
