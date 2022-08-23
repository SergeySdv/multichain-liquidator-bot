package collector

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestParseWorkItem(t *testing.T) {
	expectedRPCEndpoint := "https://sample-rpc.com:443"
	expectedContractAddress := "mars123456"
	expectedContractItemPrefix := "user_debt"
	expectedContractPageOffset := 1
	expectedContractPageLimit := 15

	input := fmt.Sprintf(
		`{"rpc_endpoint":"%s","contract_address":"%s","contract_item_prefix":"%s","contract_page_offset":%d,"contract_page_limit":%d}`,
		expectedRPCEndpoint,
		expectedContractAddress,
		expectedContractItemPrefix,
		expectedContractPageOffset,
		expectedContractPageLimit,
	)

	var workItem WorkItem
	err := json.Unmarshal([]byte(input), &workItem)
	if err != nil {
		t.Errorf("unable to parse WorkItem JSON: %s", err)
		return
	}

	if expectedRPCEndpoint != workItem.RPCEndpoint {
		t.Errorf(
			"parsed WorkItem RPC endpoint did not match input JSON. Expected '%s', got '%s'",
			expectedRPCEndpoint,
			workItem.RPCEndpoint,
		)
	}

	if expectedContractAddress != workItem.ContractAddress {
		t.Errorf(
			"parsed WorkItem Contract address did not match input JSON. Expected '%s', got '%s'",
			expectedContractAddress,
			workItem.ContractAddress,
		)
	}

	if expectedContractItemPrefix != workItem.ContractItemPrefix {
		t.Errorf(
			"parsed WorkItem Contract item prefix did not match input JSON. Expected '%s', got '%s'",
			expectedContractItemPrefix,
			workItem.ContractItemPrefix,
		)
	}

	if expectedContractPageOffset != int(workItem.ContractPageOffset) {
		t.Errorf(
			"parsed WorkItem Contract page offset did not match input JSON. Expected '%d', got '%d'",
			expectedContractPageOffset,
			workItem.ContractPageOffset,
		)
	}

	if expectedContractPageLimit != int(workItem.ContractPageLimit) {
		t.Errorf(
			"parsed WorkItem Contract page limit did not match input JSON. Expected '%d', got '%d'",
			expectedContractPageLimit,
			workItem.ContractPageLimit,
		)
	}
}
