package domain

// DeliveryFailure records a downstream stage failure, not an account attempt.
type DeliveryFailure struct {
	SubrequestIndex int64  `json:"subrequestIndex"`
	ImageIndex      int    `json:"imageIndex"`
	Stage           string `json:"stage"`
	Status          int    `json:"status"`
	Code            string `json:"code"`
}

// Attempt records one upstream account attempt inside a sub-request.
type Attempt struct {
	Index       int    `json:"index"`
	AccountID   int64  `json:"accountId"`
	AccountName string `json:"accountName"`
	Status      int    `json:"status"`
	Code        string `json:"code"`
	DurationMS  int64  `json:"durationMs"`
	Message     string `json:"message"`
}

// SubrequestTrace groups attempts for one client sub-request (index).
type SubrequestTrace struct {
	Index    int       `json:"index"`
	Attempts []Attempt `json:"attempts"`
}
