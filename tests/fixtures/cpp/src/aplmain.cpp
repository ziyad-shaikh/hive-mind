#include "aplin.h"
#include "calext.h"
namespace apl {
int compute(int a, int b) { return cal::add(a, b); }
int compute_internal(int a) { return a + 1; }
}
