#pragma once
#include <toml11/types.hpp>

namespace util {

toml::basic_value<toml::type_config> secrets();

}
