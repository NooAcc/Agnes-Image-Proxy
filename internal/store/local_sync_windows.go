package store

import "os"

// Windows FlushFileBuffers does not support read-only directory handles. File
// bytes are synced and immutable links published, but Unix directory-fsync
// crash durability is not claimed for non-container Windows deployments.
func syncDirectoryChain(_ *os.Root, _ string) error { return nil }
