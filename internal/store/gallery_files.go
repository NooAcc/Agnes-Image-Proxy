package store

import "sync"

// Lock order: gallery gate, output key (save only), picture ID. No public method
// calls another gate-taking method while a gate is held. External fetches happen
// before callers enter these operations. Independent output keys do not serialize.
type operationLocks struct {
	mu   sync.Mutex
	keys map[string]*operationLock
}
type operationLock struct {
	mu    sync.Mutex
	users int
}

func (locks *operationLocks) lock(key string) func() {
	locks.mu.Lock()
	if locks.keys == nil {
		locks.keys = make(map[string]*operationLock)
	}
	item := locks.keys[key]
	if item == nil {
		item = &operationLock{}
		locks.keys[key] = item
	}
	item.users++
	locks.mu.Unlock()
	item.mu.Lock()
	return func() {
		item.mu.Unlock()
		locks.mu.Lock()
		item.users--
		if item.users == 0 {
			delete(locks.keys, key)
		}
		locks.mu.Unlock()
	}
}
