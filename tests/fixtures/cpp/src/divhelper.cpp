#include "divin.h"
#include "aplext.h"
#include "calext.h"
namespace div_mod {
int divide(int a, int b) { return b == 0 ? 0 : a / b; }
int safe_divide(int a, int b) {
    int sum = cal::add(a, b);
    return sum == 0 ? 0 : a / sum;
}
}
