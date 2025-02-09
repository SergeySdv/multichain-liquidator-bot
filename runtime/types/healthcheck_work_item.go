package types

// HealthCheckWorkItem defines the parameters for the collector to send to the
// health checker
type HealthCheckWorkItem struct {
	Address    string    `json:"address"`
	Debts      []Asset   `json:"debts"`
	Collateral []Asset   `json:"collateral"`
	Endpoints  Endpoints `json:"endpoints"`
}

// Asset denote the format for an amount of specific tokens
type Asset struct {
	Token  string `json:"token"`
	Amount string `json:"amount"`
}

// Endpoints denote the format for usable endpoints
type Endpoints struct {
	Hive string `json:"hive"`
	LCD  string `json:"lcd"`
	RPC  string `json:"rpc"`
}
