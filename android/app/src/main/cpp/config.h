#define OPUS_BUILD 1
#define OPUS_VERSION "1.6.1"

#define HAVE_LRINT 1
#define HAVE_LRINTF 1

#define OPUS_HAVE_RTCD 0
#define ENABLE_FLOAT_API 1

/* Fixed-point configuration */
#define FIXED_POINT 1

/* Architecture */
#define SIZEOF_INT 4
#define SIZEOF_LONG 8

/* Endianness (little-endian on Android ARM64) */
#define LITTLE_ENDIAN 1
#define BYTE_ORDER LITTLE_ENDIAN

/* OS-specific */
#define inline __inline__
