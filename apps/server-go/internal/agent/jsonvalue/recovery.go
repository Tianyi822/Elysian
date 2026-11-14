package jsonvalue

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strconv"
	"strings"
)

// RecoveryFingerprint is an opaque, typed argument identity. Transport request
// IDs and equivalent numeric spellings cannot reset a no-progress limit.
func RecoveryFingerprint(raw json.RawMessage) (string, error) {
	args, err := Object(raw)
	if err != nil {
		return "", err
	}
	delete(args, "requestId")
	value, _ := json.Marshal(recoveryValue(args))
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:]), nil
}

func recoveryValue(value any) any {
	switch v := value.(type) {
	case json.Number:
		if len(v) <= 1024 {
			bounded := true
			if i := strings.IndexAny(string(v), "eE"); i >= 0 {
				e, err := strconv.Atoi(string(v)[i+1:])
				bounded = err == nil && e >= -1024 && e <= 1024
			}
			if bounded {
				if r, ok := new(big.Rat).SetString(string(v)); ok {
					return []any{"number", r.RatString()}
				}
			}
		}
		return []any{"number", string(v)}
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, child := range v {
			out[key] = recoveryValue(child)
		}
		return []any{"object", out}
	case []any:
		out := make([]any, len(v))
		for i, child := range v {
			out[i] = recoveryValue(child)
		}
		return []any{"array", out}
	default:
		return []any{"scalar", value}
	}
}
